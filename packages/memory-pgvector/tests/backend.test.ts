import { describe, expect, it, vi } from "vitest";
import { createPgVectorBackend, type PgPoolLike } from "../src/backend.js";
import type { Logger } from "../src/types.js";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakePool(
  handler: (sql: string, values?: unknown[]) => { rows: unknown[] },
): PgPoolLike & { calls: Array<{ sql: string; values?: unknown[] }> } {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, ...(values ? { values } : {}) });
      return handler(sql, values);
    },
    async end() {},
  };
}

describe("createPgVectorBackend", () => {
  it("bootstraps with the configured table + embedding dim", async () => {
    // First call: DDL. Second call: reltuples size check for the
    // large-table warning — returns 0 so we stay quiet.
    const pool = fakePool((sql) =>
      sql.includes("pg_class") ? { rows: [{ n: 0 }] } : { rows: [] },
    );
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [0, 0, 0],
      config: { table: "my_memories", embeddingDim: 3 },
      logger: silentLogger,
    });
    await backend.bootstrap();
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0]!.sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(pool.calls[0]!.sql).toContain("CREATE TABLE IF NOT EXISTS my_memories");
    expect(pool.calls[0]!.sql).toContain("embedding vector(3)");
    expect(pool.calls[1]!.sql).toContain("reltuples::bigint");
  });

  it("ingest() calls embed() then upserts via source_id when present", async () => {
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const pool = fakePool(() => ({ rows: [{ id: "uuid-abc" }] }));
    const backend = createPgVectorBackend({
      pool,
      embed,
      config: { embeddingDim: 3 },
      logger: silentLogger,
    });
    const out = await backend.ingest({
      content: "decision: use rate limits",
      metadata: {
        source_id: "confluence:42",
        domain: "work",
        project: "alpha",
        type: "decision",
      },
    });
    expect(out.id).toBe("uuid-abc");
    expect(embed).toHaveBeenCalledWith("decision: use rate limits");
    expect(pool.calls[0]!.sql).toContain("ON CONFLICT (workspace, source_id)");
    expect(pool.calls[0]!.values?.[0]).toBe("confluence:42");
  });

  it("ingest() takes the simple insert path when source_id missing", async () => {
    const pool = fakePool(() => ({ rows: [{ id: "uuid-plain" }] }));
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [1, 2],
      config: { embeddingDim: 2 },
      logger: silentLogger,
    });
    await backend.ingest({ content: "hi", metadata: {} });
    expect(pool.calls[0]!.sql).not.toContain("ON CONFLICT");
  });

  it("ingest() rejects embedding-dim mismatches before touching pg", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [0.1, 0.2],
      config: { embeddingDim: 768 },
      logger: silentLogger,
    });
    await expect(
      backend.ingest({ content: "x", metadata: {} }),
    ).rejects.toThrow(/dims/);
    expect(pool.calls).toHaveLength(0);
  });

  it("search() fuses candidates and returns Engram-shaped Memory objects", async () => {
    const pool = fakePool(() => ({
      rows: [
        {
          id: "m1",
          content: "body one",
          metadata: { project: "alpha", type: "doc" },
          created_at: "2026-04-22T10:00:00Z",
          score: "0.0342",
        },
        {
          id: "m2",
          content: "body two",
          metadata: { project: "alpha" },
          created_at: new Date("2026-04-21T10:00:00Z"),
          score: 0.0298,
        },
      ],
    }));
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [0.1, 0.2, 0.3],
      config: { embeddingDim: 3 },
      logger: silentLogger,
    });
    const hits = await backend.search({
      query: "what decisions about rate limiting",
      project: "alpha",
      limit: 5,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      id: "m1",
      content: "body one",
      score: 0.0342,
      type: "doc",
      createdAt: "2026-04-22T10:00:00Z",
    });
    // Date object should be ISO-serialized.
    expect(hits[1]!.createdAt).toBe("2026-04-21T10:00:00.000Z");
    expect(pool.calls[0]!.sql).toContain("metadata->>'project' = $");
  });

  it("healthCheck() reports healthy when pgvector extension + table are present", async () => {
    const pool = fakePool(() => ({
      rows: [{ has_vector: true, has_table: true, row_count: "17" }],
    }));
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [0, 0],
      config: { embeddingDim: 2 },
      logger: silentLogger,
    });
    const h = await backend.healthCheck();
    expect(h.healthy).toBe(true);
    expect(h.details?.row_count).toBe(17);
  });

  it("healthCheck() reports unhealthy when the extension is missing", async () => {
    const pool = fakePool(() => ({
      rows: [{ has_vector: false, has_table: false, row_count: 0 }],
    }));
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [0, 0],
      config: { embeddingDim: 2 },
      logger: silentLogger,
    });
    const h = await backend.healthCheck();
    expect(h.healthy).toBe(false);
    expect(h.message).toMatch(/pgvector extension/);
  });

  it("healthCheck() reports unhealthy when the table is missing", async () => {
    const pool = fakePool(() => ({
      rows: [{ has_vector: true, has_table: false, row_count: 0 }],
    }));
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [0, 0],
      config: { embeddingDim: 2 },
      logger: silentLogger,
    });
    const h = await backend.healthCheck();
    expect(h.healthy).toBe(false);
    expect(h.message).toMatch(/does not exist/);
  });

  it("healthCheck() swallows pool errors and returns unhealthy", async () => {
    const pool: PgPoolLike = {
      async query() {
        throw new Error("connection refused");
      },
    };
    const backend = createPgVectorBackend({
      pool,
      embed: async () => [0, 0],
      config: { embeddingDim: 2 },
      logger: silentLogger,
    });
    const h = await backend.healthCheck();
    expect(h.healthy).toBe(false);
    expect(h.message).toMatch(/connection refused/);
  });
});
