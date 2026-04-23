import { z } from "zod";
import type { HealthStatus } from "@onenomad/cortex-core";
import { isSafeIdentifier, buildBootstrapSql } from "./schema.js";
import {
  buildHealthQuery,
  buildHybridSearchQuery,
  buildIngestQuery,
} from "./queries.js";
import type {
  EmbedFn,
  Logger,
  Memory,
  MemoryBackend,
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
      logger.info("memory-pgvector.bootstrap.done", {
        table: cfg.table,
        embeddingDim: cfg.embeddingDim,
      });
    },

    async ingest(input: MemoryIngestInput) {
      const embedding = await embed(input.content);
      if (embedding.length !== cfg.embeddingDim) {
        throw new Error(
          `memory-pgvector: embed() returned ${embedding.length} dims, table expects ${cfg.embeddingDim}. ` +
            `Either change embeddingDim to match the model or pass a different embed().`,
        );
      }

      const md = input.metadata ?? {};
      const sourceId = typeof md.source_id === "string" ? md.source_id : null;
      const domain = typeof md.domain === "string" ? md.domain : "work";

      const q = buildIngestQuery({
        table: cfg.table,
        sourceId,
        domain,
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

    async healthCheck(): Promise<HealthStatus> {
      try {
        const res = await pool.query<{
          has_vector: boolean;
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
        const healthy = row.has_vector === true;
        return {
          healthy,
          message: healthy
            ? ""
            : "pgvector extension not installed on this database",
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
          details: {
            has_vector: row.has_vector,
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
  };
}
