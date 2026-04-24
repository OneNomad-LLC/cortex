import type { EngramAccess, HealthStatus, Logger } from "@onenomad/cortex-core";
import type { LLMRouter } from "@onenomad/cortex-llm-core";
import {
  createPgPool,
  createPgVectorBackend,
  type MemoryBackend,
} from "@onenomad/cortex-memory-pgvector";
import type {
  EngramClient,
  EngramMemory,
  EngramSearchArgs,
} from "./engram.js";

export interface PgVectorClientOptions {
  connectionString: string;
  table: string;
  embeddingDim: number;
  embedTask: string;
  llmRouter: LLMRouter;
  logger: Logger;
}

/**
 * Adapts `@onenomad/cortex-memory-pgvector`'s MemoryBackend to the EngramClient shape
 * the rest of the server already consumes. The point: callers don't have to
 * know which backend served the call; switching primary + fallback is a
 * config + factory change, not a tool-level refactor.
 *
 * Embeddings are produced by the LLM router using the `embed` task. The
 * router resolves that to a provider implementing `embed()` (Ollama today);
 * providers that don't are skipped automatically.
 */
export async function createPgVectorClient(
  opts: PgVectorClientOptions,
): Promise<EngramClient> {
  const pool = createPgPool(
    { connectionString: opts.connectionString },
    { logger: opts.logger },
  );
  const backend: MemoryBackend = createPgVectorBackend({
    pool,
    embed: async (text) => {
      const res = await opts.llmRouter.embed({
        task: opts.embedTask,
        input: text,
      });
      return res.vector;
    },
    config: {
      table: opts.table,
      embeddingDim: opts.embeddingDim,
    },
    logger: opts.logger,
  });

  // One-time schema bootstrap. Idempotent — cheap on subsequent starts.
  await backend.bootstrap();

  return wrapAsEngramClient(backend, opts.logger);
}

function wrapAsEngramClient(
  backend: MemoryBackend,
  logger: Logger,
): EngramClient {
  const access: EngramAccess = {
    ingest: (input) => backend.ingest(input),
    healthCheck: () => backend.healthCheck(),
  };

  return {
    ...access,

    async search(args: EngramSearchArgs): Promise<EngramMemory[]> {
      const hits = await backend.search({
        query: args.query,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.sinceIso !== undefined ? { sinceIso: args.sinceIso } : {}),
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
      });
      // The MemoryBackend search shape is already a structural superset of
      // EngramMemory — just forward.
      return hits.map((h) => ({
        id: h.id,
        content: h.content,
        ...(h.score !== undefined ? { score: h.score } : {}),
        ...(h.metadata !== undefined ? { metadata: h.metadata } : {}),
        ...(h.createdAt !== undefined ? { createdAt: h.createdAt } : {}),
        ...(h.type !== undefined ? { type: h.type } : {}),
      }));
    },

    async healthCheck(): Promise<HealthStatus> {
      return backend.healthCheck();
    },

    async shutdown(): Promise<void> {
      try {
        await backend.shutdown();
      } catch (err) {
        logger.warn("pgvector.shutdown.error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
