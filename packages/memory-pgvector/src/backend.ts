import { z } from "zod";
import type { HealthStatus } from "@onenomad/przm-cortex-core";
import { isSafeIdentifier, buildBootstrapSql } from "./schema.js";
import {
  buildDeleteQuery,
  buildHealthQuery,
  buildHybridSearchQuery,
  buildIngestQuery,
} from "./queries.js";
import type {
  EmbedFn,
  Logger,
  Memory,
  MemoryBackend,
  MemoryDeleteArgs,
  MemoryExportRow,
  MemoryIngestInput,
  MemorySearchArgs,
} from "./types.js";

/**
 * Tiny structural slice of node-postgres' Pool. Declared here so this
 * package can be unit-tested without spinning up a real pool — tests pass in
 * a hand-rolled `{ query }` shim.
 */
export interface PgPoolLike {
  query<T = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
  /**
   * Embedded-mode dump hook. Implemented by the PGlite pool wrapper;
   * external-Postgres pools throw "not supported" because their dump
   * path is operator-managed (pg_dump from outside the process).
   *
   * Returns a Blob containing the entire PGlite data directory as a
   * gzipped tar. The blob is consumed via .stream() / .arrayBuffer()
   * by the caller (typically pyre-web's cold-storage orchestrator).
   *
   * Optional so non-dumpable backends don't have to stub it. Callers
   * check `typeof pool.dumpDataDir === 'function'` before invoking.
   */
  dumpDataDir?(): Promise<Blob>;
}

export const pgVectorConfigSchema = z.object({
  /** Postgres connection string. Typical: `postgres://user:pw@host:5432/db`. */
  connectionString: z.string().optional(),
  /** Table name for memories. Must match `[A-Za-z_][A-Za-z0-9_]*`. */
  table: z.string().default("cortex_memories"),
  /** Embedding dimension. Must match the model you pass in `embed`. */
  embeddingDim: z.number().int().positive().default(768),
  /** Default search result cap. */
  defaultLimit: z.number().int().positive().default(10),
  /** RRF constant. See queries.ts for why 60 is the default. */
  rrfK: z.number().int().positive().default(60),
  /** Per-channel candidate cap. Higher = better fusion quality, slower. */
  channelMultiplier: z.number().int().positive().default(4),
  /**
   * Pool tuning — passed through to createPgPool when it owns the pool.
   * Ignored when callers construct their own pool and hand it in.
   */
  poolMax: z.number().int().positive().default(10),
  poolIdleTimeoutMs: z.number().int().nonnegative().default(30_000),
  poolConnectionTimeoutMs: z.number().int().nonnegative().default(5_000),
});

export type PgVectorConfig = z.infer<typeof pgVectorConfigSchema>;

export interface PgVectorBackendOptions {
  pool: PgPoolLike;
  embed: EmbedFn;
  config?: Partial<PgVectorConfig>;
  logger: Logger;
}

/**
 * Hybrid search memory backend. Implements the same ingest/search/health
 * contract as the Engram MCP client, so the server can swap either side
 * (or use one as a fallback for the other) without tool-level changes.
 */
export function createPgVectorBackend(
  opts: PgVectorBackendOptions,
): MemoryBackend {
  const cfg = pgVectorConfigSchema.parse(opts.config ?? {});
  if (!isSafeIdentifier(cfg.table)) {
    throw new Error(`memory-pgvector: unsafe table name '${cfg.table}'`);
  }

  let lastSuccessAt: number | undefined;
  const { pool, embed, logger } = opts;

  return {
    async bootstrap() {
      const sql = buildBootstrapSql({
        table: cfg.table,
        embeddingDim: cfg.embeddingDim,
      });
      // Postgres accepts multiple statements in a single simple-query; we
      // rely on that rather than splitting on `;` (which is fragile — a
      // future statement could legitimately contain a semicolon in a
      // string).
      await pool.query(sql);

      // Warn if the table already has meaningful size — bootstrap's
      // `CREATE INDEX IF NOT EXISTS` no-ops when the index is already
      // there, but if someone dropped an index manually, a rebuild on a
      // large table blocks writes. Telling the operator up front is
      // cheaper than a silent stall.
      const sizeRes = await pool.query<{ n: string | number }>(
        `SELECT COALESCE((SELECT reltuples::bigint FROM pg_class WHERE relname = $1), 0) AS n`,
        [cfg.table],
      );
      const n = Number(sizeRes.rows[0]?.n ?? 0);
      if (n > 100_000) {
        logger.warn("memory-pgvector.bootstrap.large_table", {
          table: cfg.table,
          approxRows: n,
          note: "ANALYZE and index rebuilds may take time; run manually if you've dropped indexes.",
        });
      }

      logger.info("memory-pgvector.bootstrap.done", {
        table: cfg.table,
        embeddingDim: cfg.embeddingDim,
        approxRows: n,
      });
    },

    async ingest(input: MemoryIngestInput) {
      // Use embedText when present (ADR-020: enrichment-augmented vector);
      // fall back to content so the default path is byte-identical to pre-ADR-020.
      const textToEmbed = input.embedText ?? input.content;
      const embedding = await embed(textToEmbed);
      if (embedding.length !== cfg.embeddingDim) {
        throw new Error(
          `memory-pgvector: embed() returned ${embedding.length} dims, table expects ${cfg.embeddingDim}. ` +
            `Either change embeddingDim to match the model or pass a different embed().`,
        );
      }

      const md = input.metadata ?? {};
      const sourceId = typeof md.source_id === "string" ? md.source_id : null;
      const domain = typeof md.domain === "string" ? md.domain : "work";
      const workspace = typeof md.workspace === "string" ? md.workspace : null;

      const q = buildIngestQuery({
        table: cfg.table,
        sourceId,
        domain,
        workspace,
        content: input.content,
        metadata: md,
        embedding,
      });
      const res = await pool.query<{ id: string }>(q.text, q.values);
      lastSuccessAt = Date.now();
      const row = res.rows[0];
      if (!row) {
        throw new Error("memory-pgvector: ingest returned no row");
      }
      return { id: row.id };
    },

    async ingestMany(inputs: MemoryIngestInput[]) {
      // Sequential under the hood — node-postgres pools don't pipeline
      // across clients, and multi-row upsert with `ON CONFLICT (...)`
      // needs every row to match the same embedding dim. Per-row lets
      // partial failures still succeed for siblings.
      const results: { id: string }[] = [];
      const errors: { index: number; error: string }[] = [];
      for (const [i, input] of inputs.entries()) {
        try {
          results.push(await this.ingest(input));
        } catch (err) {
          errors.push({
            index: i,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (errors.length > 0) {
        logger.warn("memory-pgvector.ingest_many.partial", {
          total: inputs.length,
          succeeded: results.length,
          failed: errors.length,
        });
      }
      return { results, errors };
    },

    async search(args: MemorySearchArgs) {
      const queryEmbedding = await embed(args.query);
      if (queryEmbedding.length !== cfg.embeddingDim) {
        throw new Error(
          `memory-pgvector: embed() returned ${queryEmbedding.length} dims, expected ${cfg.embeddingDim}`,
        );
      }
      const q = buildHybridSearchQuery({
        table: cfg.table,
        queryEmbedding,
        queryText: args.query,
        search: { ...args, limit: args.limit ?? cfg.defaultLimit },
        k: cfg.rrfK,
        channelLimit: Math.max(
          (args.limit ?? cfg.defaultLimit) * cfg.channelMultiplier,
          40,
        ),
      });
      const res = await pool.query<{
        id: string;
        content: string;
        metadata: Record<string, unknown>;
        created_at: Date | string | null;
        score: string | number;
      }>(q.text, q.values);
      lastSuccessAt = Date.now();

      return res.rows.map((r): Memory => {
        const createdAt =
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : typeof r.created_at === "string"
              ? r.created_at
              : undefined;
        return {
          id: r.id,
          content: r.content,
          score: typeof r.score === "string" ? Number(r.score) : r.score,
          metadata: r.metadata,
          ...(createdAt ? { createdAt } : {}),
          ...(typeof r.metadata?.type === "string"
            ? { type: r.metadata.type }
            : {}),
        };
      });
    },

    async delete(args: MemoryDeleteArgs) {
      const q = buildDeleteQuery({
        table: cfg.table,
        ...(args.sourceId !== undefined ? { sourceId: args.sourceId } : {}),
        ...(args.id !== undefined ? { id: args.id } : {}),
      });
      const res = await pool.query<{ id: string }>(q.text, q.values);
      lastSuccessAt = Date.now();
      return { deleted: res.rows.length };
    },

    async healthCheck(): Promise<HealthStatus> {
      try {
        const res = await pool.query<{
          has_vector: boolean;
          has_table: boolean;
          row_count: string | number;
        }>(buildHealthQuery(cfg.table));
        lastSuccessAt = Date.now();
        const row = res.rows[0];
        if (!row) {
          return {
            healthy: false,
            message: "healthcheck returned no rows",
            ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
          };
        }
        const healthy = row.has_vector === true && row.has_table === true;
        const message = !row.has_vector
          ? "pgvector extension not installed on this database"
          : !row.has_table
            ? `memories table '${cfg.table}' does not exist — run bootstrap()`
            : "";
        return {
          healthy,
          message,
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
          details: {
            has_vector: row.has_vector,
            has_table: row.has_table,
            row_count:
              typeof row.row_count === "string"
                ? Number(row.row_count)
                : row.row_count,
            table: cfg.table,
          },
        };
      } catch (err) {
        logger.warn("memory-pgvector.healthcheck.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        };
      }
    },

    async shutdown() {
      if (pool.end) await pool.end();
    },

    async wipeAll() {
      // DELETE over TRUNCATE: works in both PGlite and standard PG,
      // returns a row-count, and leaves the table + indexes in place
      // so the next ingest doesn't need to rebuild HNSW from scratch.
      // For a single-tenant Cortex this is sub-second even at 100k
      // rows; a TRUNCATE would be faster but PGlite's TRUNCATE doesn't
      // return a count.
      const res = await pool.query<{ deleted: string | number }>(
        `WITH deleted AS (DELETE FROM ${cfg.table} RETURNING 1)
         SELECT count(*)::text AS deleted FROM deleted`,
      );
      const raw = res.rows[0]?.deleted ?? 0;
      const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
      return { deleted: Number.isFinite(n) ? n : 0 };
    },

    exportAll(opts: {
      includeEmbedding?: boolean;
      batchSize?: number;
    } = {}): AsyncIterable<MemoryExportRow> {
      const includeEmbedding = opts.includeEmbedding === true;
      const batchSize = Math.max(1, Math.min(opts.batchSize ?? 200, 1000));
      const selectCols = includeEmbedding
        ? "id, source_id, content, metadata, embedding, created_at, updated_at"
        : "id, source_id, content, metadata, created_at, updated_at";

      return streamExport({
        pool,
        table: cfg.table,
        selectCols,
        batchSize,
        includeEmbedding,
      });
    },

    // Embedded-only — delegates to the PGlite pool wrapper. External
    // Postgres pools don't implement this; the resulting `undefined`
    // method on MemoryBackend is what pyre-web's orchestrator probes
    // for to decide whether cold storage applies to a given deployment.
    ...(pool.dumpDataDir
      ? {
          async dumpDataDir(): Promise<Blob> {
            return pool.dumpDataDir!();
          },
        }
      : {}),
  };
}

interface ExportPageRow {
  id: string;
  source_id: string | null;
  content: string;
  metadata: unknown;
  embedding?: number[] | null;
  created_at: string;
  updated_at: string;
}

async function* streamExport(args: {
  pool: PgPoolLike;
  table: string;
  selectCols: string;
  batchSize: number;
  includeEmbedding: boolean;
}): AsyncGenerator<MemoryExportRow, void, undefined> {
  const { pool, table, selectCols, batchSize, includeEmbedding } = args;
  // Stream via id-based keyset pagination — stable under concurrent
  // ingest, deterministic order, no offset performance cliff at scale.
  // We rely on uuid id being lexicographically sortable.
  let cursor: string | null = null;
  while (true) {
    const params: unknown[] = [];
    let whereClause = "";
    if (cursor !== null) {
      params.push(cursor);
      whereClause = `WHERE id > $${params.length}`;
    }
    params.push(batchSize);
    const limitIdx = params.length;
    const sqlText: string =
      `SELECT ${selectCols} FROM ${table} ${whereClause} ORDER BY id LIMIT $${limitIdx}`;
    const page: { rows: ExportPageRow[] } = await pool.query<ExportPageRow>(
      sqlText,
      params,
    );
    if (page.rows.length === 0) break;
    for (const r of page.rows) {
      const row: MemoryExportRow = {
        id: r.id,
        content: r.content,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
      if (r.source_id) row.sourceId = r.source_id;
      if (includeEmbedding && Array.isArray(r.embedding)) {
        row.embedding = r.embedding;
      }
      yield row;
    }
    const lastRow = page.rows[page.rows.length - 1];
    if (!lastRow) break;
    cursor = lastRow.id;
    if (page.rows.length < batchSize) break;
  }
}
