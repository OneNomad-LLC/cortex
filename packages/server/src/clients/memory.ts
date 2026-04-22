import type { Logger } from "@cortex/core";
import type { LLMRouter } from "@cortex/llm-core";
import type { MemoryConfig } from "../config.js";
import { createEngramClient } from "./engram.js";
import { createPgVectorClient } from "./pgvector.js";
import type { EngramClient } from "./engram.js";

export interface MemoryBootResult {
  /** The backend Cortex will use for ingest/search/health from this point. */
  client: EngramClient;
  /** Which backend was actually selected. */
  selected: "engram" | "pgvector";
  /** True when the primary was healthy; false means we're running on the fallback. */
  primaryHealthy: boolean;
}

/**
 * Boot the memory backend described by `config/cortex.yaml > memory`.
 *
 * Policy:
 *   1. Spawn the primary backend (engram = stdio subprocess, pgvector = pg pool).
 *   2. Run its healthCheck. If healthy, use it.
 *   3. If not healthy and a `fallback` is configured (and differs from primary),
 *      spawn + health-check the fallback. Use it if healthy.
 *   4. If neither is healthy, throw.
 *
 * Runtime per-call fallback is intentionally not implemented here. The
 * configured primary is picked once per process; swapping later requires
 * a restart. That's the right default — memory write paths are hard to
 * reason about if they split mid-session, and operators want to see
 * "we're running on pgvector because engram was down at boot" in the log
 * rather than guess from intermittent tool behavior.
 */
export async function createMemoryClient(args: {
  memory: MemoryConfig;
  llmRouter: LLMRouter;
  logger: Logger;
}): Promise<MemoryBootResult> {
  const { memory, llmRouter, logger } = args;

  const primary = memory.primary;
  const fallback =
    memory.fallback && memory.fallback !== memory.primary
      ? memory.fallback
      : undefined;

  const built = await build(primary, memory, llmRouter, logger);
  const primaryHealth = await built.healthCheck();
  if (primaryHealth.healthy) {
    logger.info("memory.ready", { selected: primary, fallback: fallback ?? null });
    return { client: built, selected: primary, primaryHealthy: true };
  }

  logger.warn("memory.primary_unhealthy", {
    backend: primary,
    message: primaryHealth.message,
  });

  // Shut the primary down — we're not going to use it, and leaving an
  // engram subprocess hanging (or a pg pool open) just eats handles.
  try {
    await built.shutdown();
  } catch (err) {
    logger.warn("memory.primary_shutdown.error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!fallback) {
    throw new Error(
      `memory: primary backend '${primary}' is unhealthy and no fallback is configured. ` +
        `Either start '${primary}' or set memory.fallback in cortex.yaml.`,
    );
  }

  const fbClient = await build(fallback, memory, llmRouter, logger);
  const fbHealth = await fbClient.healthCheck();
  if (!fbHealth.healthy) {
    throw new Error(
      `memory: both primary ('${primary}') and fallback ('${fallback}') are unhealthy. ` +
        `Primary: ${primaryHealth.message}. Fallback: ${fbHealth.message}.`,
    );
  }
  logger.warn("memory.using_fallback", {
    from: primary,
    to: fallback,
    reason: primaryHealth.message,
  });
  return { client: fbClient, selected: fallback, primaryHealthy: false };
}

async function build(
  backend: "engram" | "pgvector",
  memory: MemoryConfig,
  llmRouter: LLMRouter,
  logger: Logger,
): Promise<EngramClient> {
  if (backend === "engram") {
    return createEngramClient({
      logger,
      ...(memory.engram.command ? { command: memory.engram.command } : {}),
      ...(memory.engram.args.length > 0 ? { args: memory.engram.args } : {}),
      ...(Object.keys(memory.engram.env).length > 0
        ? { env: memory.engram.env }
        : {}),
    });
  }
  if (backend === "pgvector") {
    const conn = memory.pgvector.connectionString;
    if (!conn) {
      throw new Error(
        "memory.pgvector.connectionString is not set. Point it at a Postgres " +
          "instance with pgvector installed (or use ${POSTGRES_URL} in cortex.yaml).",
      );
    }
    return createPgVectorClient({
      connectionString: conn,
      table: memory.pgvector.table,
      embeddingDim: memory.pgvector.embeddingDim,
      embedTask: memory.pgvector.embedTask,
      llmRouter,
      logger,
    });
  }
  throw new Error(`memory: unknown backend '${backend as string}'`);
}
