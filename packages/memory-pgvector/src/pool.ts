import { Pool, type PoolConfig } from "pg";
import type { PgPoolLike, ScopedQuery } from "./backend.js";
import type { Logger } from "./types.js";

/** A safe, double-quotable SQL role identifier. */
const SAFE_ROLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface CreatePgPoolOptions {
  /**
   * Logger for idle-client errors. node-postgres emits `error` on the
   * Pool when an idle client hits a network blip or the server drops
   * the connection; without a listener the default behavior is to
   * crash the process. Passing a logger keeps the process alive.
   */
  logger?: Logger;
  /**
   * Restricted (NOSUPERUSER, non-`BYPASSRLS`) role the tenant-scoped path
   * (`withRlsScope`) lowers into via `SET LOCAL ROLE`, so RLS policies actually
   * enforce (ADR-021). The base connection role must be a member of it. Omit
   * only when RLS is off or in trusted single-role setups — without it,
   * `withRlsScope` still sets `app.tenant` but a privileged base role bypasses
   * RLS. Mirrors przm-access `createPgPool`.
   */
  appRole?: string;
}

/**
 * Convenience factory: wrap node-postgres' Pool in the minimal `PgPoolLike`
 * shape the backend wants. Callers that already have a Pool they'd rather
 * share (e.g. from a Next.js API layer) can skip this and pass their pool
 * directly — the backend only calls `.query` and optional `.end`.
 */
export function createPgPool(
  cfg: PoolConfig,
  opts: CreatePgPoolOptions = {},
): PgPoolLike {
  const { appRole } = opts;
  if (appRole !== undefined && !SAFE_ROLE_IDENTIFIER.test(appRole)) {
    throw new Error(
      `memory-pgvector: appRole '${appRole}' is not a safe SQL identifier`,
    );
  }
  const pool = new Pool(cfg);
  pool.on("error", (err) => {
    opts.logger?.error("memory-pgvector.pool.idle_client_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return {
    async query<T = unknown>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }> {
      const res = await pool.query(text, values as unknown[]);
      // pg returns `QueryResult<any>`; the backend layers stronger types on
      // top, so we cast through `unknown` to the caller's requested shape.
      return { rows: res.rows as unknown as T[] };
    },

    async withRlsScope<T>(
      tenantId: string,
      fn: (q: ScopedQuery) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        // Lower into the restricted role for this transaction (if configured)
        // so RLS applies, then bind the tenant GUC. `set_config(_, _, true)` =
        // SET LOCAL — scoped to the tx, reset on COMMIT/ROLLBACK. The role
        // identifier is regex-validated above; the tenant id is a bind param.
        if (appRole) {
          await client.query(`BEGIN; SET LOCAL ROLE "${appRole}"`);
        } else {
          await client.query("BEGIN");
        }
        await client.query(`SELECT set_config('app.tenant', $1, true)`, [
          tenantId,
        ]);
        const scoped: ScopedQuery = async <R = unknown>(
          text: string,
          values?: unknown[],
        ) => {
          const res = await client.query(text, values as unknown[]);
          return { rows: res.rows as unknown as R[] };
        };
        const result = await fn(scoped);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A rollback failure must not mask the original error.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async end() {
      await pool.end();
    },
  };
}
