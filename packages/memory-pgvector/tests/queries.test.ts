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
      content: "hello",
      metadata: { project: "alpha", type: "doc" },
      embedding: [0.1, 0.2, 0.3],
    });
    expect(q.text).toContain("INSERT INTO cortex_memories");
    expect(q.text).toContain(
      "ON CONFLICT (source_id) WHERE source_id IS NOT NULL",
    );
    expect(q.text).toContain("DO UPDATE SET");
    expect(q.text).toContain("RETURNING id");
    expect(q.values).toEqual([
      "confluence:42",
      "work",
      "hello",
      JSON.stringify({ project: "alpha", type: "doc" }),
      "[0.1,0.2,0.3]",
    ]);
  });

  it("skips the ON CONFLICT branch when sourceId is null", () => {
    const q = buildIngestQuery({
      table: "cortex_memories",
      sourceId: null,
      domain: "work",
      content: "hi",
      metadata: {},
      embedding: [1, 2],
    });
    expect(q.text).not.toContain("ON CONFLICT");
    expect(q.text).toContain("INSERT INTO cortex_memories");
    expect(q.text).toContain("RETURNING id");
    expect(q.values).toEqual(["work", "hi", "{}", "[1,2]"]);
  });

  it("rejects unsafe table names", () => {
    expect(() =>
      buildIngestQuery({
        table: "drop--table",
        sourceId: null,
        domain: "work",
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
    expect(q.text).toContain("metadata->>'project' = $");
    expect(q.text).toContain("metadata->>'type' = $");
    expect(q.text).toContain("metadata->>'source' = $");
    expect(q.text).toContain("(metadata->>'date')::timestamptz >= $");
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

describe("buildHealthQuery", () => {
  it("checks both pgvector extension presence and row count", () => {
    const sql = buildHealthQuery("cortex_memories");
    expect(sql).toContain("pg_extension");
    expect(sql).toContain("extname = 'vector'");
    expect(sql).toContain("FROM cortex_memories");
  });

  it("rejects unsafe table names", () => {
    expect(() => buildHealthQuery("cortex; DROP TABLE")).toThrow(
      /unsafe table name/,
    );
  });
});
