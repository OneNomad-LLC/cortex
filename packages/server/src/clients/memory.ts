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

  // Cold-storage restore handshake. The /api/admin/backup/restore
  // endpoint writes the incoming tarball to <dataDir>.restore-pending
  // and exits; on next boot (Fly restart_policy=always picks the
  // machine back up) we detect the marker, clear the data dir, and
  // initialize PGlite from the tarball blob. On success the marker is
  // deleted; failure leaves it for retry next boot.
  const pendingRestore = await readPendingRestoreBlob(dataDir, logger);
  const table = memory.pgvector?.table || "cortex_memories";
  // The embedding dim has to match whatever produces the vectors:
  //   - With an LLM router wired, the operator's chosen embedding model
  //     drives it. Honor the configured value.
  //   - Without an LLM router, embeddings come from the bundled Xenova
  //     model (LOCAL_EMBEDDING_DIM = 384). The Zod-defaulted 768 would
  //     mismatch and every embed() call rejects with a dim error, so we
  //     pin to 384 here and warn if the operator wrote something else.
  // useLocalEmbedder forces the local Xenova model for embeddings even
  // when an LLM router is configured. Operators set this when their
  // chosen LLM provider doesn't have an embedding model — most common
  // case: Azure OpenAI behind the openrouter shim, where the configured
  // chat model (gpt-4o-mini) is not an embedding model and Azure
  // embedding deployments are a separate resource. Without this flag,
  // every kb_search query fails with `Provider does not support
  // embeddings`. Defaults to false to preserve the existing behavior
  // for operators with embedding-capable providers configured.
  const useLocalEmbedder = memory.pgvector?.useLocalEmbedder === true;
  const effectiveRouter = useLocalEmbedder ? undefined : llmRouter;

  const configuredDim = memory.pgvector?.embeddingDim;
  let embeddingDim: number;
  if (effectiveRouter) {
    embeddingDim =
      configuredDim && configuredDim > 0 ? configuredDim : LOCAL_EMBEDDING_DIM;
  } else {
    embeddingDim = LOCAL_EMBEDDING_DIM;
    if (
      configuredDim &&
      configuredDim > 0 &&
      configuredDim !== LOCAL_EMBEDDING_DIM
    ) {
      logger.warn("memory.embedding_dim_overridden", {
        configured: configuredDim,
        used: LOCAL_EMBEDDING_DIM,
        reason:
          "Embeddings come from the local Xenova model. " +
          "Set memory.pgvector.embeddingDim to 384 (or omit it) to silence this warning.",
      });
    }
  }
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
        ...(effectiveRouter ? { llmRouter: effectiveRouter } : {}),
        logger,
      })
    : await createPgVectorClient({
        mode: "embedded",
        dataDir,
        table,
        embeddingDim,
        embedTask,
        ...(effectiveRouter ? { llmRouter: effectiveRouter } : {}),
        ...(pendingRestore ? { loadFromBlob: pendingRestore } : {}),
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
    embedder: effectiveRouter ? "llm-router" : "local-xenova",
    ...(pendingRestore ? { restoredFromBackup: true } : {}),
  });

  // PGlite initialized successfully from the restore blob — clear the
  // marker so the next boot doesn't re-apply it. Done after the
  // healthcheck so we only delete on a confirmed-working restore.
  if (pendingRestore) {
    await clearPendingRestoreMarker(dataDir, logger);
  }

  return { client, selected: "pgvector", primaryHealthy: true };
}

/**
 * Path to the restore-marker file. Sits next to (not inside) the
 * dataDir so PGlite doesn't try to treat the tarball as a corrupt
 * data file. The /api/admin/backup/restore endpoint writes here.
 */
function pendingRestorePath(dataDir: string): string {
  return `${dataDir}.restore-pending.tar.gz`;
}

async function readPendingRestoreBlob(
  dataDir: string,
  logger: Logger,
): Promise<Blob | undefined> {
  const marker = pendingRestorePath(dataDir);
  const fs = await import("node:fs/promises");
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(marker);
  } catch {
    return undefined; // No pending restore — common path on every boot.
  }
  if (!stat.isFile()) return undefined;

  logger.warn("memory.restore.pending_detected", {
    marker,
    sizeBytes: stat.size,
    hint: "wiping data dir + initializing PGlite from the tarball blob",
  });

  // Wipe any existing data dir contents so PGlite's loadDataDir lands
  // a clean tree. The marker file lives outside the data dir so this
  // rm doesn't touch it.
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });

  const buf = await fs.readFile(marker);
  // PGlite's loadDataDir expects a Blob or File. Node's native Blob
  // (since 18) is structurally compatible.
  return new Blob([new Uint8Array(buf)], { type: "application/gzip" });
}

async function clearPendingRestoreMarker(
  dataDir: string,
  logger: Logger,
): Promise<void> {
  const marker = pendingRestorePath(dataDir);
  const fs = await import("node:fs/promises");
  try {
    await fs.unlink(marker);
    logger.info("memory.restore.completed", { marker });
  } catch (err) {
    logger.warn("memory.restore.marker_cleanup_failed", {
      marker,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
