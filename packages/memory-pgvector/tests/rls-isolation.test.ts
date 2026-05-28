/**
 * Cross-tenant RLS isolation for the cortex memory table (ADR-021).
 *
 * Proves the policy SQL emitted by `buildBootstrapSql({ enableRls: true })`
 * actually isolates tenants — A cannot read/update/delete/insert B's rows —
 * and that RLS is genuinely ON (not silently bypassed).
 *
 * Harness mirrors the przm-access isolation test. PGlite runs as the
 * `postgres` superuser, which carries BYPASSRLS, so we create a NOSUPERUSER
 * role `cortex_app` and `SET LOCAL ROLE` into it inside each transaction;
 * `FORCE ROW LEVEL SECURITY` (in the policy DDL) then applies. The tenant is
 * carried in the `app.tenant` GUC, exactly as the production withRlsSession
 * path will set it (Phase 2/3).
 *
 * This is the only test in this package that spins up real PGlite (the others
 * use a fake pool), so it is a touch slower — that's the price of proving real
 * row-level security rather than asserting on generated SQL strings.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { buildBootstrapSql } from "../src/schema.js";

const TABLE = "cortex_memories";
const DIM = 4;
const VEC = "[0,0,0,0]";

const tenantA = randomUUID();
const tenantB = randomUUID();

let db: PGlite;

/**
 * Run a single statement inside a transaction lowered to the restricted role
 * with `app.tenant` set to `tenant` (or unset when null). Returns the rows.
 * Throws (after ROLLBACK) if the statement is refused — used to assert that
 * INSERT WITH CHECK rejects cross-tenant writes.
 */
async function asTenant<R = Record<string, unknown>>(
  tenant: string | null,
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const setGuc = tenant
    ? `SELECT set_config('app.tenant', '${tenant}', true);`
    : "";
  await db.exec(`BEGIN; SET LOCAL ROLE cortex_app; ${setGuc}`);
  try {
    const res = await db.query<R>(text, params);
    await db.exec("COMMIT");
    return res.rows;
  } catch (err) {
    await db.exec("ROLLBACK").catch(() => {});
    throw err;
  }
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { vector } });

  // Apply the production bootstrap DDL with RLS enabled — the exact SQL an
  // external multi-tenant deployment runs.
  await db.exec(buildBootstrapSql({ table: TABLE, embeddingDim: DIM, enableRls: true }));

  // Restricted role the scoped transactions lower into (no BYPASSRLS).
  await db.exec(`
    CREATE ROLE cortex_app NOSUPERUSER NOLOGIN;
    GRANT USAGE ON SCHEMA public TO cortex_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO cortex_app;
  `);

  // Seed one row per tenant via the restricted path (tenant_id = the GUC, so
  // the INSERT WITH CHECK passes).
  await asTenant(tenantA, `INSERT INTO ${TABLE} (tenant_id, content, metadata, embedding) VALUES ($1, $2, '{}'::jsonb, $3::vector)`, [tenantA, "alpha-secret", VEC]);
  await asTenant(tenantB, `INSERT INTO ${TABLE} (tenant_id, content, metadata, embedding) VALUES ($1, $2, '{}'::jsonb, $3::vector)`, [tenantB, "beta-secret", VEC]);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe("SELECT isolation", () => {
  it("tenant A sees exactly its own row", async () => {
    const rows = await asTenant<{ content: string }>(tenantA, `SELECT content FROM ${TABLE}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("alpha-secret");
  });

  it("tenant B sees exactly its own row", async () => {
    const rows = await asTenant<{ content: string }>(tenantB, `SELECT content FROM ${TABLE}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("beta-secret");
  });

  it("A gets 0 rows even filtering explicitly on B's tenant_id", async () => {
    const rows = await asTenant(tenantA, `SELECT id FROM ${TABLE} WHERE tenant_id = $1`, [tenantB]);
    expect(rows).toHaveLength(0);
  });
});

describe("write isolation", () => {
  it("A cannot UPDATE B's rows — RETURNING is empty", async () => {
    const rows = await asTenant(tenantA, `UPDATE ${TABLE} SET content = 'pwned' WHERE tenant_id = $1 RETURNING id`, [tenantB]);
    expect(rows).toHaveLength(0);
  });

  it("B's row is untouched after A's cross-tenant update attempt", async () => {
    const rows = await asTenant<{ content: string }>(tenantB, `SELECT content FROM ${TABLE}`);
    expect(rows[0]?.content).toBe("beta-secret");
  });

  it("A cannot DELETE B's rows — RETURNING is empty", async () => {
    const rows = await asTenant(tenantA, `DELETE FROM ${TABLE} WHERE tenant_id = $1 RETURNING id`, [tenantB]);
    expect(rows).toHaveLength(0);
  });

  it("A cannot INSERT a row stamped with B's tenant_id (WITH CHECK)", async () => {
    await expect(
      asTenant(tenantA, `INSERT INTO ${TABLE} (tenant_id, content, metadata, embedding) VALUES ($1, $2, '{}'::jsonb, $3::vector)`, [tenantB, "evil", VEC]),
    ).rejects.toThrow();
  });
});

describe("RLS sanity guard — proves enforcement isn't silently bypassed", () => {
  it("restricted role with NO app.tenant set sees 0 rows", async () => {
    const rows = await asTenant(null, `SELECT id FROM ${TABLE}`);
    expect(rows).toHaveLength(0);
  });

  it("…while the rows physically exist (superuser bypasses RLS)", async () => {
    const res = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${TABLE}`);
    expect(res.rows[0]?.count).toBe("2");
  });
});

describe("embedded mode is unaffected (enableRls defaults off)", () => {
  it("a table bootstrapped without RLS has no row-security and stays readable", async () => {
    const plain = await PGlite.create({ extensions: { vector } });
    try {
      await plain.exec(buildBootstrapSql({ table: "plain_memories", embeddingDim: DIM }));
      await plain.query(
        `INSERT INTO plain_memories (tenant_id, content, metadata, embedding) VALUES ($1, $2, '{}'::jsonb, $3::vector)`,
        [randomUUID(), "visible", VEC],
      );
      // No role lowering, no GUC — would be hidden if RLS were on. It isn't.
      const rows = await plain.query<{ content: string }>(`SELECT content FROM plain_memories`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.content).toBe("visible");

      const rls = await plain.query<{ relrowsecurity: boolean }>(
        `SELECT relrowsecurity FROM pg_class WHERE relname = 'plain_memories'`,
      );
      expect(rls.rows[0]?.relrowsecurity).toBe(false);
    } finally {
      await plain.close();
    }
  });
});
