/**
 * Cross-tenant RLS isolation for the cortex memory table (ADR-021), driven
 * through the REAL `withRlsSession` from `@onenomad/przm-access`.
 *
 * This is the Phase 2a integration proof: the published contract helper, a
 * cortex scoped pool, and the cortex RLS policy DDL together isolate tenants —
 * A cannot read/update/delete/insert B's rows — and RLS is genuinely ON.
 *
 * Harness: PGlite runs as the `postgres` superuser (BYPASSRLS), so we create a
 * NOSUPERUSER role `cortex_app` and lower into it inside each transaction. The
 * inline `RlsPool` below intercepts the `BEGIN` that `withRlsSession` issues and
 * appends `SET LOCAL ROLE cortex_app`; `FORCE ROW LEVEL SECURITY` (in the policy
 * DDL) then applies. `withRlsSession` itself sets the `app.tenant` GUC the
 * policies read. `@onenomad/przm-access` is a devDependency — the test exercises
 * the contract; the package carries no cortex runtime dependency.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { withRlsSession } from "@onenomad/przm-access";
import type { Principal, RlsPool } from "@onenomad/przm-access";
import { buildBootstrapSql } from "../src/schema.js";

const TABLE = "cortex_memories";
const DIM = 4;
const VEC = "[0,0,0,0]";
const APP_ROLE = "cortex_app";

const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

const principalA: Principal = { tenantId: tenantA, userId: userA, role: "admin" };
const principalB: Principal = { tenantId: tenantB, userId: userB, role: "admin" };

let db: PGlite;
let pool: RlsPool;

/**
 * A contract-shaped RlsPool backed by a single PGlite instance. `withRlsSession`
 * calls connect() → query("BEGIN") → setRlsContext → fn → query("COMMIT"). We
 * intercept BEGIN to also lower into the non-superuser role so RLS applies; the
 * single embedded connection makes release() a no-op. (Production uses a pg pool
 * with the same BEGIN/SET-LOCAL-ROLE shape — Phase 2b.)
 */
function pgliteRlsPool(instance: PGlite, appRole: string): RlsPool {
  return {
    async connect() {
      return {
        async query<R = unknown>(text: string, params?: readonly unknown[]) {
          if (text.trim().toUpperCase() === "BEGIN") {
            await instance.exec(`BEGIN; SET LOCAL ROLE ${appRole};`);
            return { rows: [] as R[] };
          }
          const res = await instance.query<R>(text, params as unknown[] | undefined);
          return { rows: res.rows };
        },
        release() {
          /* single embedded connection — nothing to return to a pool */
        },
      };
    },
  };
}

/** Run one statement under `principal` via the real contract helper. */
async function asTenant<R = Record<string, unknown>>(
  principal: Principal,
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const { rows } = await withRlsSession(pool, principal, (c) =>
    c.query<R>(text, params),
  );
  return rows;
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { vector } });
  await db.exec(buildBootstrapSql({ table: TABLE, embeddingDim: DIM, enableRls: true }));
  await db.exec(`
    CREATE ROLE ${APP_ROLE} NOSUPERUSER NOLOGIN;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${APP_ROLE};
  `);
  pool = pgliteRlsPool(db, APP_ROLE);

  // Seed one row per tenant through the real withRlsSession write path
  // (tenant_id = the app.tenant GUC, so the INSERT WITH CHECK passes).
  await asTenant(principalA, `INSERT INTO ${TABLE} (tenant_id, content, metadata, embedding) VALUES ($1, $2, '{}'::jsonb, $3::vector)`, [tenantA, "alpha-secret", VEC]);
  await asTenant(principalB, `INSERT INTO ${TABLE} (tenant_id, content, metadata, embedding) VALUES ($1, $2, '{}'::jsonb, $3::vector)`, [tenantB, "beta-secret", VEC]);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe("SELECT isolation (via withRlsSession)", () => {
  it("tenant A sees exactly its own row", async () => {
    const rows = await asTenant<{ content: string }>(principalA, `SELECT content FROM ${TABLE}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("alpha-secret");
  });

  it("tenant B sees exactly its own row", async () => {
    const rows = await asTenant<{ content: string }>(principalB, `SELECT content FROM ${TABLE}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("beta-secret");
  });

  it("A gets 0 rows even filtering explicitly on B's tenant_id", async () => {
    const rows = await asTenant(principalA, `SELECT id FROM ${TABLE} WHERE tenant_id = $1`, [tenantB]);
    expect(rows).toHaveLength(0);
  });
});

describe("write isolation", () => {
  it("A cannot UPDATE B's rows — RETURNING is empty", async () => {
    const rows = await asTenant(principalA, `UPDATE ${TABLE} SET content = 'pwned' WHERE tenant_id = $1 RETURNING id`, [tenantB]);
    expect(rows).toHaveLength(0);
  });

  it("B's row is untouched after A's cross-tenant update attempt", async () => {
    const rows = await asTenant<{ content: string }>(principalB, `SELECT content FROM ${TABLE}`);
    expect(rows[0]?.content).toBe("beta-secret");
  });

  it("A cannot DELETE B's rows — RETURNING is empty", async () => {
    const rows = await asTenant(principalA, `DELETE FROM ${TABLE} WHERE tenant_id = $1 RETURNING id`, [tenantB]);
    expect(rows).toHaveLength(0);
  });

  it("A cannot INSERT a row stamped with B's tenant_id (WITH CHECK)", async () => {
    await expect(
      asTenant(principalA, `INSERT INTO ${TABLE} (tenant_id, content, metadata, embedding) VALUES ($1, $2, '{}'::jsonb, $3::vector)`, [tenantB, "evil", VEC]),
    ).rejects.toThrow();
  });
});

describe("RLS sanity guard — proves enforcement isn't silently bypassed", () => {
  it("restricted role with NO app.tenant set sees 0 rows", async () => {
    // Bypass withRlsSession (which always sets the GUC): open the lowered-role
    // transaction directly with no app.tenant, like a forgotten scope.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{ id: string }>(`SELECT id FROM ${TABLE}`);
      await client.query("COMMIT");
      expect(res.rows).toHaveLength(0);
    } finally {
      client.release();
    }
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
