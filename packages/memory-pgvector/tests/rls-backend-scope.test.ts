/**
 * ADR-021 Phase 2b — the backend's tenant-scoped path.
 *
 * Proves `createPgVectorBackend`'s ingest/search route through `withRlsScope`
 * when a `tenantId` is supplied and the pool supports it: each tenant's writes
 * are stamped and reads are isolated by Postgres RLS — without the backend
 * taking any dependency on `@onenomad/przm-access` (it only sets `app.tenant`
 * from the tenantId string; the server owns the Principal).
 *
 * The test pool below implements `withRlsScope` over PGlite the same way the
 * production pg pool does (lower role + `set_config('app.tenant', …, true)`),
 * with a NOSUPERUSER role so `FORCE ROW LEVEL SECURITY` actually applies.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { createPgVectorBackend, type PgPoolLike, type ScopedQuery } from "../src/backend.js";
import type { Logger, MemoryBackend } from "../src/types.js";

const TABLE = "cortex_memories";
const APP_ROLE = "cortex_app";
const tenantA = randomUUID();
const tenantB = randomUUID();

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A PgPoolLike over PGlite that implements withRlsScope (mirrors the pg pool). */
function pglitePoolWithScope(db: PGlite, appRole: string): PgPoolLike {
  const run = async <T>(text: string, values?: unknown[]) => {
    if (!values || values.length === 0) {
      const results = await db.exec(text);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []) as T[] };
    }
    const res = await db.query<T>(text, values as unknown[]);
    return { rows: res.rows };
  };
  return {
    query: run,
    async withRlsScope<T>(tenantId: string, fn: (q: ScopedQuery) => Promise<T>): Promise<T> {
      await db.exec(`BEGIN; SET LOCAL ROLE ${appRole};`);
      try {
        await db.query(`SELECT set_config('app.tenant', $1, true)`, [tenantId]);
        const out = await fn(run as ScopedQuery);
        await db.exec("COMMIT");
        return out;
      } catch (err) {
        await db.exec("ROLLBACK").catch(() => {});
        throw err;
      }
    },
  };
}

let db: PGlite;
let backend: MemoryBackend;

beforeAll(async () => {
  db = await PGlite.create({ extensions: { vector } });
  const pool = pglitePoolWithScope(db, APP_ROLE);
  backend = createPgVectorBackend({
    pool,
    embed: async () => [0, 0, 0, 0],
    config: { table: TABLE, embeddingDim: 4, enableRls: true },
    logger: silent,
  });
  await backend.bootstrap(); // RLS-enabled DDL (enableRls: true)
  await db.exec(`
    CREATE ROLE ${APP_ROLE} NOSUPERUSER NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${APP_ROLE};
  `);

  await backend.ingest({ content: "alpha quarterly planning notes", metadata: {}, tenantId: tenantA });
  await backend.ingest({ content: "beta quarterly planning notes", metadata: {}, tenantId: tenantB });
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe("backend tenant scoping (Phase 2b)", () => {
  it("stamps tenant_id on ingest (rows physically carry their tenant)", async () => {
    const res = await db.query<{ tenant_id: string; content: string }>(
      `SELECT tenant_id, content FROM ${TABLE} ORDER BY content`,
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
  });

  it("search scoped to tenant A returns only A's memory", async () => {
    const hits = await backend.search({ query: "quarterly planning", tenantId: tenantA });
    expect(hits.length).toBe(1);
    expect(hits[0]?.content).toContain("alpha");
  });

  it("search scoped to tenant B returns only B's memory", async () => {
    const hits = await backend.search({ query: "quarterly planning", tenantId: tenantB });
    expect(hits.length).toBe(1);
    expect(hits[0]?.content).toContain("beta");
  });

  it("tenant A cannot delete tenant B's row (RLS hides it from the scoped tx)", async () => {
    // Find B's id via the superuser connection (bypasses RLS).
    const bId = (
      await db.query<{ id: string }>(`SELECT id FROM ${TABLE} WHERE tenant_id = $1`, [tenantB])
    ).rows[0]?.id;
    expect(bId).toBeTruthy();

    const result = await backend.delete({ id: bId!, tenantId: tenantA });
    expect(result.deleted).toBe(0);

    // B's row still present.
    const still = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${TABLE} WHERE tenant_id = $1`,
      [tenantB],
    );
    expect(still.rows[0]?.n).toBe("1");
  });
});
