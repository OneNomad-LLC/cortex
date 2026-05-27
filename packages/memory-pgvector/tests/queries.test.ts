import { describe, expect, it } from "vitest";
import {
  buildHealthQuery,
  buildHybridSearchQuery,
  buildIngestQuery,
  vectorLiteral,
} from "../src/queries.js";

describe("vectorLiteral", () => {
  it("formats numbers into pgvector text form", () => {
    expect(vectorLiteral([1, 2, 3.5])).toBe("[1,2,3.5]");
  });

  it("rejects NaN / Infinity embeddings", () => {
    expect(() => vectorLiteral([1, Number.NaN, 3])).toThrow(/non-finite/);
    expect(() => vectorLiteral([1, Number.POSITIVE_INFINITY])).toThrow(
      /non-finite/,
    );
  });
});

describe("buildIngestQuery", () => {
  it("uses the upsert path when a sourceId is present", () => {
    const q = buildIngestQuery({
      table: "cortex_memories",
      sourceId: "confluence:42",
      domain: "work",
      workspace: "onenomad",
      content: "hello",
      metadata: { project: "alpha", type: "doc", workspace: "onenomad" },
      embedding: [0.1, 0.2, 0.3],
    });
    expect(q.text).toContain("INSERT INTO cortex_memories");
    expect(q.text).toContain(
      "ON CONFLICT (workspace, source_id) WHERE source_id IS NOT NULL",
    );
    expect(q.text).toContain("DO UPDATE SET");
    expect(q.text).toContain("RETURNING id");
    expect(q.values).toEqual([
      "confluence:42",
      "work",
      "onenomad",
      "hello",
      JSON.stringify({ project: "alpha", type: "doc", workspace: "onenomad" }),
      "[0.1,0.2,0.3]",
    ]);
  });

  it("writes a null workspace when unbound (legacy-compat path)", () => {
    const q = buildIngestQuery({
      table: "cortex_memories",
      sourceId: "x",
      domain: "work",
      workspace: null,
      content: "hi",
      metadata: {},
      embedding: [1],
    });
    expect(q.values[2]).toBeNull();
  });

  it("skips the ON CONFLICT branch when sourceId is null", () => {
    const q = buildIngestQuery({
      table: "cortex_memories",
      sourceId: null,
      domain: "work",
      workspace: null,
      content: "hi",
      metadata: {},
      embedding: [1, 2],
    });
    expect(q.text).not.toContain("ON CONFLICT");
    expect(q.text).toContain("INSERT INTO cortex_memories");
    expect(q.text).toContain("RETURNING id");
    expect(q.values).toEqual(["work", null, "hi", "{}", "[1,2]"]);
  });

  it("rejects unsafe table names", () => {
    expect(() =>
      buildIngestQuery({
        table: "drop--table",
        sourceId: null,
        domain: "work",
        workspace: null,
        content: "x",
        metadata: {},
        embedding: [1],
      }),
    ).toThrow(/unsafe table name/);
  });
});

describe("buildHybridSearchQuery", () => {
  it("emits vec + txt CTEs fused via RRF, with no WHERE when no filters apply", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1, 0.2],
      queryText: "what did we decide about auth",
      search: { query: "what did we decide about auth", limit: 5 },
    });
    expect(q.text).toContain("WITH vec AS");
    expect(q.text).toContain("ROW_NUMBER() OVER (ORDER BY embedding <=>");
    expect(q.text).toContain("websearch_to_tsquery('english',");
    expect(q.text).toContain("SUM(score)");
    // Neither CTE should have a filter WHERE before the inner AND/WHERE —
    // without filters, the opening clause is `WHERE embedding IS NOT NULL`.
    expect(q.text).toContain("WHERE embedding IS NOT NULL");
    expect(q.text).toContain("WHERE tsv @@");
    // First param placeholders: vec, text, channelLimit, k, outerLimit.
    expect(q.values.slice(0, 2)).toEqual([
      "[0.1,0.2]",
      "what did we decide about auth",
    ]);
    // channelLimit = max(limit*4, 40) = max(20, 40) = 40.
    expect(q.values).toContain(40);
    // Outer limit is the caller's `limit`.
    expect(q.values[q.values.length - 1]).toBe(5);
  });

  it("applies project/type/source/domain/since filters in both CTEs", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.5, 0.5],
      queryText: "rate limiting",
      search: {
        query: "rate limiting",
        limit: 10,
        project: "alpha",
        type: "doc",
        source: "confluence",
        domain: "work",
        sinceIso: "2026-01-01T00:00:00Z",
      },
    });
    expect(q.text).toContain("domain = $");
    // Project filter matches either a string or an array containing the slug.
    expect(q.text).toContain("metadata->>'project' = $");
    expect(q.text).toContain("metadata->'project' @> to_jsonb(ARRAY[");
    expect(q.text).toContain("metadata->>'type' = $");
    expect(q.text).toContain("metadata->>'source' = $");
    // Date is stored + compared as text (ISO 8601 sorts the same as chrono);
    // the schema rationale rejects ::timestamptz casts because text->timestamptz
    // is STABLE and Postgres won't index STABLE expressions. See schema.ts.
    expect(q.text).toContain("(metadata->>'date') >= $");
    // Filters live inside the CTEs so `AND embedding IS NOT NULL` / `AND tsv @@`
    // follow the shared WHERE — vec and txt both get pre-filtered.
    expect(q.text).toContain("AND embedding IS NOT NULL");
    expect(q.text).toContain("AND tsv @@");
    expect(q.values).toContain("work");
    expect(q.values).toContain("alpha");
    expect(q.values).toContain("doc");
    expect(q.values).toContain("confluence");
    expect(q.values).toContain("2026-01-01T00:00:00Z");
  });

  it("uses caller-provided k and channelLimit when passed", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "x",
      search: { query: "x", limit: 3 },
      k: 42,
      channelLimit: 100,
    });
    expect(q.values).toContain(100);
    expect(q.values).toContain(42);
  });
});

describe("buildHybridSearchQuery — maxSensitivity filter (#4)", () => {
  it("adds a sensitivity IN predicate when maxSensitivity is set", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1, 0.2],
      queryText: "test",
      search: { query: "test", limit: 5, maxSensitivity: "internal" },
    });
    // Should allow public + internal but not confidential/restricted.
    expect(q.text).toContain("metadata->>'sensitivity' IS NULL OR metadata->>'sensitivity' IN (");
    expect(q.values).toContain("public");
    expect(q.values).toContain("internal");
    expect(q.values).not.toContain("confidential");
    expect(q.values).not.toContain("restricted");
  });

  it("allows all levels up to and including maxSensitivity=confidential", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test", maxSensitivity: "confidential" },
    });
    expect(q.values).toContain("public");
    expect(q.values).toContain("internal");
    expect(q.values).toContain("confidential");
    expect(q.values).not.toContain("restricted");
  });

  it("allows only public when maxSensitivity=public", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test", maxSensitivity: "public" },
    });
    expect(q.values).toContain("public");
    expect(q.values).not.toContain("internal");
    expect(q.values).not.toContain("confidential");
    expect(q.values).not.toContain("restricted");
  });

  it("omits the sensitivity predicate when maxSensitivity is not set (default)", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test" },
    });
    expect(q.text).not.toContain("sensitivity");
  });

  it("NULL-tolerant: rows with no sensitivity stamp pass the predicate", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test", maxSensitivity: "internal" },
    });
    // The NULL guard must appear so untagged legacy rows remain visible.
    expect(q.text).toContain("metadata->>'sensitivity' IS NULL");
  });
});

describe("buildHybridSearchQuery — trust ranking (#3)", () => {
  it("applies a 0.85 penalty multiplier to experimental/external rows by default", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test" },
    });
    expect(q.text).toContain("0.85");
    expect(q.text).toContain("'experimental'");
    expect(q.text).toContain("'external'");
    // Score column alias must still be 'score' so the outer caller picks it up.
    expect(q.text).toContain("AS score");
    expect(q.text).toContain("ORDER BY score DESC");
  });

  it("omits the trust multiplier when minTrust is set (strict exclusion path)", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test", minTrust: "approved" },
    });
    // With strict exclusion, the multiplier CASE is not emitted.
    expect(q.text).not.toContain("0.85");
    // The WHERE predicate for trust exclusion should appear.
    expect(q.text).toContain("metadata->>'trust' IS NULL OR metadata->>'trust' IN (");
    expect(q.values).toContain("approved");
  });

  it("minTrust=experimental allows approved + experimental, excludes external", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test", minTrust: "experimental" },
    });
    expect(q.values).toContain("experimental");
    expect(q.values).toContain("approved");
    expect(q.values).not.toContain("external");
  });

  it("minTrust=external passes all trust values through (only excludes if below external, which is impossible)", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test", minTrust: "external" },
    });
    expect(q.values).toContain("external");
    expect(q.values).toContain("experimental");
    expect(q.values).toContain("approved");
  });

  it("NULL-tolerant: rows with no trust stamp pass the minTrust predicate", () => {
    const q = buildHybridSearchQuery({
      table: "cortex_memories",
      queryEmbedding: [0.1],
      queryText: "test",
      search: { query: "test", minTrust: "approved" },
    });
    expect(q.text).toContain("metadata->>'trust' IS NULL");
  });
});

describe("buildHealthQuery", () => {
  it("checks pgvector extension, table existence, and an approx row count", () => {
    const sql = buildHealthQuery("cortex_memories");
    expect(sql).toContain("pg_extension");
    expect(sql).toContain("extname = 'vector'");
    expect(sql).toContain("to_regclass('cortex_memories')");
    expect(sql).toContain("reltuples::bigint");
    expect(sql).toContain("'cortex_memories'");
  });

  it("rejects unsafe table names", () => {
    expect(() => buildHealthQuery("cortex; DROP TABLE")).toThrow(
      /unsafe table name/,
    );
  });
});
