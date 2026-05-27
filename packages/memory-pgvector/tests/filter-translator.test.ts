/**
 * Unit tests for the translateFilter helper in queries.ts.
 *
 * Each test verifies the SQL fragment and parameter array produced by the
 * translator, independent of the full hybrid-search query builder.
 */

import { describe, expect, it } from "vitest";
import { translateFilter } from "../src/queries.js";
import type { FilterNode } from "../src/queries.js";

// ---------------------------------------------------------------------------
// $eq
// ---------------------------------------------------------------------------

describe("translateFilter — $eq", () => {
  it("emits col = $N and pushes the value", () => {
    const values: unknown[] = [];
    const sql = translateFilter({ "domain": { $eq: "work" } }, values);
    expect(sql).toBe("domain = $1");
    expect(values).toEqual(["work"]);
  });

  it("parameter index increments when values already present", () => {
    const values: unknown[] = ["existing"];
    const sql = translateFilter({ "domain": { $eq: "work" } }, values);
    expect(sql).toBe("domain = $2");
    expect(values).toEqual(["existing", "work"]);
  });

  it("handles numeric values", () => {
    const values: unknown[] = [];
    const sql = translateFilter({ "count": { $eq: 42 } }, values);
    expect(sql).toBe("count = $1");
    expect(values).toEqual([42]);
  });
});

// ---------------------------------------------------------------------------
// $gte
// ---------------------------------------------------------------------------

describe("translateFilter — $gte", () => {
  it("emits col >= $N and pushes the value", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      { ["(metadata->>'date')"]: { $gte: "2026-01-01T00:00:00Z" } },
      values,
    );
    expect(sql).toBe("(metadata->>'date') >= $1");
    expect(values).toEqual(["2026-01-01T00:00:00Z"]);
  });
});

// ---------------------------------------------------------------------------
// $in
// ---------------------------------------------------------------------------

describe("translateFilter — $in", () => {
  it("emits col IN ($1, $2, ...) for multiple values", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      { "status": { $in: ["a", "b", "c"] } },
      values,
    );
    expect(sql).toBe("status IN ($1, $2, $3)");
    expect(values).toEqual(["a", "b", "c"]);
  });

  it("handles a single-element IN list", () => {
    const values: unknown[] = [];
    const sql = translateFilter({ "status": { $in: ["only"] } }, values);
    expect(sql).toBe("status IN ($1)");
    expect(values).toEqual(["only"]);
  });
});

// ---------------------------------------------------------------------------
// $eqOrNull
// ---------------------------------------------------------------------------

describe("translateFilter — $eqOrNull", () => {
  it("emits (col = $N OR col IS NULL)", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      { "workspace": { $eqOrNull: "onenomad" } },
      values,
    );
    expect(sql).toBe("(workspace = $1 OR workspace IS NULL)");
    expect(values).toEqual(["onenomad"]);
  });

  it("parameter index is correct when values already present", () => {
    const values: unknown[] = ["pre"];
    const sql = translateFilter(
      { "workspace": { $eqOrNull: "onenomad" } },
      values,
    );
    expect(sql).toBe("(workspace = $2 OR workspace IS NULL)");
    expect(values).toEqual(["pre", "onenomad"]);
  });
});

// ---------------------------------------------------------------------------
// $inOrNull
// ---------------------------------------------------------------------------

describe("translateFilter — $inOrNull", () => {
  it("emits (col IS NULL OR col IN ($1, $2))", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      { [`metadata->>'sensitivity'`]: { $inOrNull: ["public", "internal"] } },
      values,
    );
    expect(sql).toBe(
      "(metadata->>'sensitivity' IS NULL OR metadata->>'sensitivity' IN ($1, $2))",
    );
    expect(values).toEqual(["public", "internal"]);
  });

  it("single value produces IN ($N)", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      { [`metadata->>'trust'`]: { $inOrNull: ["approved"] } },
      values,
    );
    expect(sql).toBe(
      "(metadata->>'trust' IS NULL OR metadata->>'trust' IN ($1))",
    );
    expect(values).toEqual(["approved"]);
  });

  it("parameter numbering continues from existing values", () => {
    const values: unknown[] = ["x", "y"];
    const sql = translateFilter(
      { "col": { $inOrNull: ["a", "b"] } },
      values,
    );
    expect(sql).toBe("(col IS NULL OR col IN ($3, $4))");
    expect(values).toEqual(["x", "y", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// $and
// ---------------------------------------------------------------------------

describe("translateFilter — $and", () => {
  it("wraps each branch in parens and joins with AND", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      {
        $and: [
          { "domain": { $eq: "work" } },
          { "workspace": { $eqOrNull: "onenomad" } },
        ],
      },
      values,
    );
    // $and wraps each branch in parens; $eqOrNull already emits (col = $N OR col IS NULL),
    // so the outer $and paren produces a double-wrapped form for that branch.
    expect(sql).toBe(
      "(domain = $1) AND ((workspace = $2 OR workspace IS NULL))",
    );
    expect(values).toEqual(["work", "onenomad"]);
  });

  it("handles nested $and", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      {
        $and: [
          {
            $and: [
              { "a": { $eq: "1" } },
              { "b": { $eq: "2" } },
            ],
          },
          { "c": { $eq: "3" } },
        ],
      },
      values,
    );
    expect(sql).toBe("((a = $1) AND (b = $2)) AND (c = $3)");
    expect(values).toEqual(["1", "2", "3"]);
  });
});

// ---------------------------------------------------------------------------
// $or
// ---------------------------------------------------------------------------

describe("translateFilter — $or", () => {
  it("wraps each branch in parens and joins with OR", () => {
    const values: unknown[] = [];
    const sql = translateFilter(
      {
        $or: [
          { "type": { $eq: "doc" } },
          { "type": { $eq: "brief" } },
        ],
      },
      values,
    );
    expect(sql).toBe("(type = $1) OR (type = $2)");
    expect(values).toEqual(["doc", "brief"]);
  });
});

// ---------------------------------------------------------------------------
// Multi-key implicit $and
// ---------------------------------------------------------------------------

describe("translateFilter — multi-key implicit $and", () => {
  it("treats multiple column keys as $and", () => {
    const values: unknown[] = [];
    const node: FilterNode = {
      "domain": { $eq: "work" },
      "status": { $eq: "active" },
    };
    const sql = translateFilter(node, values);
    expect(sql).toBe("(domain = $1) AND (status = $2)");
    expect(values).toEqual(["work", "active"]);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("translateFilter — error cases", () => {
  it("throws on an empty filter node", () => {
    const values: unknown[] = [];
    expect(() => translateFilter({} as FilterNode, values)).toThrow(
      /empty filter node/,
    );
  });

  it("throws on an unknown operator", () => {
    const values: unknown[] = [];
    const badNode = { "col": { $unknown: "x" } } as unknown as FilterNode;
    expect(() => translateFilter(badNode, values)).toThrow(/unknown operator/);
  });
});

// ---------------------------------------------------------------------------
// Parameter continuity — multiple sequential translates share one values array
// ---------------------------------------------------------------------------

describe("translateFilter — shared values array across multiple calls", () => {
  it("parameter indices are globally consistent", () => {
    const values: unknown[] = [];

    const s1 = translateFilter({ "domain": { $eq: "work" } }, values);
    const s2 = translateFilter({ "workspace": { $eqOrNull: "onenomad" } }, values);
    const s3 = translateFilter(
      { [`metadata->>'sensitivity'`]: { $inOrNull: ["public", "internal"] } },
      values,
    );

    expect(s1).toBe("domain = $1");
    expect(s2).toBe("(workspace = $2 OR workspace IS NULL)");
    expect(s3).toBe(
      "(metadata->>'sensitivity' IS NULL OR metadata->>'sensitivity' IN ($3, $4))",
    );
    expect(values).toEqual(["work", "onenomad", "public", "internal"]);
  });
});
