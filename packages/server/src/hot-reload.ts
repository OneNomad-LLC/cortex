import type { Logger, SourceAdapter } from "@onenomad/cortex-core";
import type { LLMRouter } from "@onenomad/cortex-llm-core";
import type { EngramClient } from "./clients/engram.js";
import { loadCortexConfig } from "./config.js";
import { buildAdapterRegistry, type AdapterRegistry } from "./registry/adapters.js";
import { buildLLMRouter } from "./registry/providers.js";
import { loadTaxonomy, type LoadedTaxonomy } from "./taxonomy.js";
import type { Scheduler } from "./scheduler.js";
import type { HeartbeatWriter } from "./heartbeat.js";
import path from "node:path";

/**
 * Mutable container for the subsystems a running Cortex needs. The
 * dashboard API holds a single reference to this and dereferences
 * `.current` per request, so a hot-reload that swaps entries in
 * place transparently flows to every handler.
 *
 * Engram and persona stay stdio subprocesses across reloads — killing
 * them would tear down the LanceDB connection and is overkill for a
 * config change.
 */
export interface LiveState {
  configPath: string;
  repoRoot: string;
  logger: Logger;
  engram: EngramClient;
  heartbeat: HeartbeatWriter;
  // Mutable — reload() rewrites these.
  adapters: Record<string, SourceAdapter>;
  adapterRegistry: AdapterRegistry;
  /** Cortex 0.2 — `current` may be undefined when no LLM provider
   *  is configured (queue-based enrichment via MCP client). */
  router: { current: LLMRouter | undefined };
  taxonomy: { current: LoadedTaxonomy };
  scheduler: Scheduler;
}

export interface ReloadResult {
  adaptersBuilt: number;
  providersBuilt: number;
  schedulerEntries: number;
  durationMs: number;
}

/**
 * Rebuild every config-driven subsystem from the current cortex.yaml:
 *   - LLM router (provider changes land here)
 *   - Taxonomy (projects/people YAML edits)
 *   - Adapter registry (new enable/disable/reconfig flows through)
 *   - Scheduler (cron changes live-apply)
 *
 * Engram + persona subprocesses are NOT touched — they're stateful
 * and restarting them would be slow and disruptive.
 *
 * Callers should trigger this after any write to cortex.yaml /
 * cortex.local.yaml / projects.yaml / people.yaml / .env.
 */
export async function hotReload(state: LiveState): Promise<ReloadResult> {
  const started = Date.now();
  state.logger.info("reload.begin");

  const cfg = await loadCortexConfig(state.configPath);

  // Refresh taxonomy — projects.yaml / people.yaml may have changed.
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(state.repoRoot, "config", "projects.yaml"),
    peoplePath: path.join(state.repoRoot, "config", "people.yaml"),
  });
  state.taxonomy.current = taxonomy;

  // Rebuild LLM router. Consumers go through state.router.current so
  // the swap is visible after the next .current read.
  const { router: newRouter, providers } = await buildLLMRouter({
    cfg,
    env: process.env,
    logger: state.logger,
  });
  state.router.current = newRouter;

  // Old adapter registry: shut down so live streams/timers stop,
  // live network connections close.
  await state.adapterRegistry.shutdown().catch((err) => {
    state.logger.warn("reload.old_registry_shutdown_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Build fresh registry with the new router + refreshed taxonomy.
  const freshRegistry = await buildAdapterRegistry({
    cfg,
    env: process.env,
    logger: state.logger,
    buildContext: (adapterId, entryConfig, secrets) => ({
      logger: state.logger.child({ adapter: adapterId }),
      config: entryConfig,
      secrets,
      signal: new AbortController().signal,
      engram: {
        ingest: (input) => state.engram.ingest(input),
        healthCheck: () => state.engram.healthCheck(),
      },
      taxonomy,
      // Cortex 0.2 — `llm` is optional. When the reload landed on a
      // config without LLM providers, omit it entirely so adapters
      // see "no LLM" and degrade or use the enrichment callback.
      ...(newRouter
        ? {
            llm: {
              raw: newRouter,
              complete: async ({
                task,
                prompt,
                system,
                maxTokens,
                temperature,
                signal,
              }) => {
                const res = await newRouter.complete({
                  task,
                  messages: [
                    ...(system
                      ? [{ role: "system" as const, content: system }]
                      : []),
                    { role: "user" as const, content: prompt },
                  ],
                  ...(maxTokens !== undefined ? { maxTokens } : {}),
                  ...(temperature !== undefined ? { temperature } : {}),
                  ...(signal ? { signal } : {}),
                });
                return res.content;
              },
            },
          }
        : {}),
    }),
  });

  // Mutate the shared adapters map in place so every consumer that
  // holds a reference to it sees the new contents without any special
  // plumbing. Delete keys that vanished; assign everything fresh.
  for (const id of Object.keys(state.adapters)) delete state.adapters[id];
  for (const [id, adapter] of Object.entries(freshRegistry.adapters)) {
    state.adapters[id] = adapter;
  }

  // Swap the registry reference so the next shutdown() call tears
  // down the fresh adapters (the old registry's shutdown already ran).
  state.adapterRegistry = freshRegistry;

  // Scheduler: stop timers, drop entries, register new, restart.
  await state.scheduler.stop();
  state.scheduler.clear();
  for (const [id, adapter] of Object.entries(freshRegistry.adapters)) {
    state.scheduler.register(adapter, cfg.adapters[id]?.schedule);
  }
  await state.scheduler.start();

  const durationMs = Date.now() - started;
  state.logger.info("reload.done", {
    adapters: Object.keys(freshRegistry.adapters).length,
    providers: Object.keys(providers).length,
    schedulerEntries: state.scheduler.size(),
    durationMs,
  });

  return {
    adaptersBuilt: Object.keys(freshRegistry.adapters).length,
    providersBuilt: Object.keys(providers).length,
    schedulerEntries: state.scheduler.size(),
    durationMs,
  };
}
