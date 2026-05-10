import os from "node:os";
import path from "node:path";
import type { Logger } from "@onenomad/cortex-core";
import type { LLMRouter } from "@onenomad/cortex-llm-core";
import { LOCAL_EMBEDDING_DIM } from "@onenomad/cortex-memory-pgvector";
import type { MemoryConfig } from "../config.js";
import { createPgVectorClient } from "./pgvector.js";
import type { EngramClient } from "./engram.js";

export interface MemoryBootResult {
  /** The backend Cortex will use for ingest/search/health from this point. */
  client: EngramClient;
  /** Which backend was actually selected. Always 'pgvector' since
   *  Cortex 0.3 — the engram backend was dropped to make Cortex
   *  standalone-deployable (no @onenomad/engram-memory runtime dep).
   *  Old yamls with primary='engram' get auto-translated to pgvector
   *  embedded with a warn-level log so operators notice the change. */
  selected: "pgvector";
  /** Always true now (single backend, no fallback). Kept on the
   *  result shape for back-compat with callers reading it. */
  primaryHealthy: boolean;
}

/**
 * Boot the memory backend.
 *
 * Cortex 0.3+ uses pgvector exclusively. Two modes:
 *   - embedded: PGlite in-process (zero deps, default for personal installs)
 *   - external: connection string to your own Postgres + pgvector
 *
 * Embeddings come from a Cortex-internal Xenova model (MiniLM-L6-v2,
 * 384-dim) by default; an LLM router takes over when one is wired
 * (provider-specific embedding model for higher quality on cloud
 * deploys with credentials).
 *
 * Migration: yamls that still say `memory.primary: engram` are
 * auto-translated to pgvector embedded (warn-logged so the operator
 * sees the rewrite). The engram backend was Pyre's per-user memory
 * concern; Cortex is the multi-tenant knowledge engine and is now
 * entirely separate.
 */
export async function createMemoryClient(args: {
  memory: MemoryConfig;
  /** Optional. When wired, embeddings come from the configured
   *  provider's embed task. When omitted, Cortex's local Xenova
   *  embedder (Cortex-internal) handles embeddings. */
  llmRouter?: LLMRouter;
  logger: Logger;
}): Promise<MemoryBootResult> {
  const { memory, llmRouter, logger } = args;

  // Migration: legacy `engram` primary → pgvector embedded with
  // sensible defaults. Warn loudly so the operator updates their yaml.
  const usingLegacyEngram = (memory.primary as string) === "engram";
  if (usingLegacyEngram) {
    logger.warn("memory.engram_backend_deprecated", {
      message:
        "memory.primary='engram' is no longer supported in Cortex 0.3+. " +
        "Auto-translating to pgvector embedded (PGlite). Update cortex.yaml " +
        "to memory.primary='pgvector' to silence this warning.",
    });
  }

  const dataDir =
    memory.pgvector?.dataDir ||
    path.join(os.homedir(), ".cortex", "data", "pglite");
  const table = memory.pgvector?.table || "cortex_memories";
  // Local Xenova model is 384-dim. Honor an explicit override (>0)
  // when the operator wired an LLM-routed embedder of a different dim.
  const embeddingDim =
    memory.pgvector?.embeddingDim && memory.pgvector.embeddingDim > 0
      ? memory.pgvector.embeddingDim
      : LOCAL_EMBEDDING_DIM;
  const embedTask = memory.pgvector?.embedTask || "embed";

  // External vs embedded: explicit `connectionString` wins. Empty +
  // legacy-engram-translated configs land in embedded mode.
  const externalConn = memory.pgvector?.connectionString;
  const useExternal =
    !usingLegacyEngram &&
    memory.pgvector?.mode !== "embedded" &&
    typeof externalConn === "string" &&
    externalConn.length > 0;

  const client = useExternal
    ? await createPgVectorClient({
        mode: "external",
        connectionString: externalConn!,
        table,
        embeddingDim,
        embedTask,
        ...(llmRouter ? { llmRouter } : {}),
        logger,
      })
    : await createPgVectorClient({
        mode: "embedded",
        dataDir,
        table,
        embeddingDim,
        embedTask,
        ...(llmRouter ? { llmRouter } : {}),
        logger,
      });

  const health = await client.healthCheck();
  if (!health.healthy) {
    try { await client.shutdown(); } catch { /* nothing */ }
    throw new Error(
      `memory: pgvector backend is unhealthy: ${health.message}. ` +
        `Check the data directory is writable (embedded mode) or the ` +
        `connection string is reachable (external mode).`,
    );
  }
  logger.info("memory.ready", {
    selected: "pgvector",
    mode: useExternal ? "external" : "embedded",
    embedder: llmRouter ? "llm-router" : "local-xenova",
  });
  return { client, selected: "pgvector", primaryHealthy: true };
}
