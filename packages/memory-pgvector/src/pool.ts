import { Pool, type PoolConfig } from "pg";
import type { PgPoolLike } from "./backend.js";

/**
 * Convenience factory: wrap node-postgres' Pool in the minimal `PgPoolLike`
 * shape the backend wants. Callers that already have a Pool they'd rather
 * share (e.g. from a Next.js API layer) can skip this and pass their pool
 * directly — the backend only calls `.query` and optional `.end`.
 */
export function createPgPool(cfg: PoolConfig): PgPoolLike {
  const pool = new Pool(cfg);
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
    async end() {
      await pool.end();
    },
  };
}
