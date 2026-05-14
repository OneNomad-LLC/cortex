import type { EngramAccess, HealthStatus, Logger } from "@onenomad/cortex-core";
import type { LLMRouter } from "@onenomad/cortex-llm-core";
import {
  createPgPool,
  createPglitePool,
  createPgVectorBackend,
  createLocalEmbedder,
  type MemoryBackend,
} from "@onenomad/cortex-memory-pgvector";
import type {
  EngramClient,
  EngramMemory,
  EngramSearchArgs,
} from "./engram.js";

export interface PgVectorClientOptions {
  /**
   * Connection mode. 'external' uses node-postgres against the supplied
   * connectionString. 'embedded' spins up PGlite in-process at dataDir
   * — no Docker, no system PG, no port.
   */
  mode: "external" | "embedded";
  /** Required when mode='external'. */
  connectionString?: string;
  /** Required when mode='embedded'. Absolute filesystem path. */
  dataDir?: string;
  table: string;
  embeddingDim: number;
  embedTask: string;
  /**
   * Optional LLM router for embeddings. When supplied, the configured
   * `embedTask` resolves to a provider's embed() (e.g. Ollama, OpenAI).
   * When omitted, Cortex's local Xenova embedder takes over —
   * MiniLM-L6-v2 (384-dim, ~23MB on first run, zero credentials).
   * Local is the default for the standalone-Cortex story; LLM
   * routing is opt-in for higher-quality embeddings on cloud deploys
   * with credentials.
   */
  llmRouter?: LLMRouter;
  /**
   * Optional: restore the PGlite data dir from a tarball at init.
   * Caller already wiped the dataDir; pass-through to PGlite's
   * loadDataDir. Only honored in `embedded` mode.
   */
  loadFromBlob?: Blob;
  logger: Logger;
}

/**
 * Adapts `@onenomad/cortex-memory-pgvector`'s MemoryBackend to the EngramClient shape
 * the rest of the server already consumes. The point: callers don't have to
 * know which backend served the call; switching primary + fallback is a
 * config + factory change, not a tool-level refactor.
 *
 * Embeddings: prefer the LLM router when wired (provider-specific
 * model, often higher quality). Fall back to Cortex's local Xenova
 * embedder otherwise — keeps the standalone deploy story intact
 * (Cortex is fully self-sufficient; no external runtime memory dep).
 */
export async function createPgVectorClient(
  opts: PgVectorClientOptions,
): Promise<EngramClient> {
  let pool;
  if (opts.mode === "embedded") {
    if (!opts.dataDir) {
      throw new Error(
        "memory.pgvector: dataDir is required when mode='embedded' — point it at a writable directory for the PGlite database",
      );
    }
    pool = await createPglitePool({
      dataDir: opts.dataDir,
      logger: opts.logger,
      ...(opts.loadFromBlob ? { loadFromBlob: opts.loadFromBlob } : {}),
    });
  } else {
    if (!opts.connectionString) {
      throw new Error(
        "memory.pgvector: connectionString is required when mode='external' — use mode='embedded' for a zero-config PGlite database instead",
      );
    }
    pool = createPgPool(
      { connectionString: opts.connectionString },
      { logger: opts.logger },
    );
  }

  // Embedder selection. LLM router wins when present (matches the
  // user's explicit provider config); local Xenova covers the
  // zero-config + no-credentials case. Built once; the factory
  // memoizes the model load on first call.
  const localEmbedder = opts.llmRouter ? null : createLocalEmbedder();
  const embed = opts.llmRouter
    ? async (text: string) => {
        const res = await opts.llmRouter!.embed({
          task: opts.embedTask,
          input: text,
        });
        return res.vector;
      }
    : localEmbedder!;

  const backend: MemoryBackend = createPgVectorBackend({
    pool,
    embed,
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

    // Delegate dumpDataDir to the backend when present (embedded mode).
    // External-pool deployments fall through to undefined, which the
    // orchestrator handles as "cold storage not applicable here."
    ...(backend.dumpDataDir
      ? {
          async dumpDataDir(): Promise<Blob> {
            return backend.dumpDataDir!();
          },
        }
      : {}),

    async wipeAll(): Promise<{ deleted: number }> {
      return backend.wipeAll();
    },

    exportAll(opts) {
      return backend.exportAll(opts);
    },
  };
}
