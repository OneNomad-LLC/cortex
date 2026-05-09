/**
 * Embedded Postgres backend via PGlite.
 *
 * PGlite is a WASM build of Postgres (~3 MB) that runs in-process —
 * no Docker, no system PG, no native bindings, no port. The pgvector
 * extension is bundled. Performance is fine for single-user / small-
 * tenant Cortex installs (which is exactly the "Pyre installs Cortex
 * on the user's laptop" use case).
 *
 * Trade-off: slower than a real PG server for very large datasets
 * (concurrent writes, complex joins). Migration to a real PG server
 * is one config change — same DDL, same SQL, just point at a different
 * connection string.
 *
 * Lazy-imports `@electric-sql/pglite` so callers that only use the
 * external Postgres path don't pay for the WASM bundle.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PgPoolLike } from "./backend.js";
import type { Logger } from "./types.js";

export interface CreatePgliteOptions {
  /**
   * Filesystem path for the persistent database directory. PGlite
   * stores its files under here; a fresh directory bootstraps an empty
   * DB on first use, subsequent opens read the existing data.
   * Pass an absolute path; the directory is created if missing.
   */
  dataDir: string;
  /** Logger for backend errors. Errors during query are also surfaced
   *  to the caller via the rejected promise; the logger is a record. */
  logger?: Logger;
}

/**
 * Wraps a PGlite instance behind the same `PgPoolLike` shape that
 * createPgPool returns, so the rest of the memory-pgvector backend
 * doesn't have to care which engine is on the other side.
 *
 * Pre-loads the `vector` extension at open time so HNSW indexes in
 * the bootstrap DDL don't fail with `extension "vector" does not
 * exist` on a fresh database.
 */
export async function createPglitePool(opts: CreatePgliteOptions): Promise<PgPoolLike> {
  // mkdir the parent so PGlite doesn't fail with ENOENT when the
  // user picks a path inside a not-yet-created cortex install dir.
  await mkdir(dirname(opts.dataDir), { recursive: true });
  await mkdir(opts.dataDir, { recursive: true });

  // Lazy-import. The pglite package pulls a ~3 MB WASM blob — only
  // loaded when the embedded backend is actually selected.
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");

  const db = await PGlite.create({
    dataDir: opts.dataDir,
    extensions: { vector },
  });

  return {
    async query<T = unknown>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }> {
      try {
        const res = await db.query<T>(text, values as unknown[]);
        return { rows: res.rows };
      } catch (err) {
        opts.logger?.error("memory-pgvector.pglite.query_failed", {
          error: err instanceof Error ? err.message : String(err),
          // First 120 chars of the SQL — enough for correlation
          // without dumping the whole hybrid-search query into logs.
          sqlPreview: text.slice(0, 120),
        });
        throw err;
      }
    },
    async end() {
      await db.close();
    },
  };
}
