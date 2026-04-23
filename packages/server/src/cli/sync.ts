import type { AdapterContext } from "@cortex/core";
import { loadCortexConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { buildAdapterRegistry } from "../registry/adapters.js";
import { buildLLMRouter } from "../registry/providers.js";
import { createMemoryClient } from "../clients/memory.js";
import { runSync } from "../sync.js";
import { resolveConfigPath } from "./config-path.js";

export interface SyncCliOptions {
  adapterId: string;
  sinceIso?: string;
  limit?: number;
  dryRun?: boolean;
}

/**
 * Parse raw argv after `sync` subcommand into options. Supported:
 *   cortex sync <adapter-id> [--since=ISO] [--limit=N] [--dry-run]
 */
export function parseSyncArgs(argv: readonly string[]): SyncCliOptions | { error: string } {
  if (argv.length === 0) {
    return { error: "cortex sync: adapter id required (e.g. `cortex sync confluence`)" };
  }
  const [adapterId, ...rest] = argv;
  if (!adapterId) return { error: "adapter id required" };

  const opts: SyncCliOptions = { adapterId };
  for (const flag of rest) {
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag.startsWith("--since=")) opts.sinceIso = flag.slice("--since=".length);
    else if (flag.startsWith("--limit=")) {
      const n = Number.parseInt(flag.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n < 0) return { error: `invalid --limit value` };
      opts.limit = n;
    } else {
      return { error: `unknown flag: ${flag}` };
    }
  }
  return opts;
}

export async function runSyncCli(argv: readonly string[]): Promise<number> {
  const parsed = parseSyncArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  const logger = createLogger({ component: "sync" });
  const configPath = resolveConfigPath();

  const cfg = await loadCortexConfig(configPath);
  const entry = cfg.adapters[parsed.adapterId];
  if (!entry) {
    process.stderr.write(
      `cortex sync: no adapter '${parsed.adapterId}' in ${configPath}\n`,
    );
    return 2;
  }
  if (!entry.enabled) {
    process.stderr.write(
      `cortex sync: adapter '${parsed.adapterId}' is disabled in cortex.yaml\n`,
    );
    return 2;
  }

  // Build just the requested adapter via a one-entry temp config.
  const trimmedCfg: typeof cfg = {
    ...cfg,
    adapters: { [parsed.adapterId]: entry },
  };

  // Build LLM router first — the pgvector memory backend uses router.embed()
  // during bootstrap, so it has to exist before we touch memory.
  const { router: llmRouter } = await buildLLMRouter({
    cfg,
    env: process.env,
    logger,
  });

  const memoryBoot = await createMemoryClient({
    memory: cfg.memory,
    llmRouter,
    logger,
  });
  const engram = memoryBoot.client;

  const registry = await buildAdapterRegistry({
    cfg: trimmedCfg,
    env: process.env,
    logger,
    buildContext: (adapterId, entryConfig, secrets) => ({
      logger: logger.child({ adapter: adapterId }),
      config: entryConfig,
      secrets,
      signal: new AbortController().signal,
      engram: {
        ingest: (input) => engram.ingest(input),
        healthCheck: () => engram.healthCheck(),
      },
      taxonomy: emptyTaxonomyReader(),
      llm: {
        raw: llmRouter,
        complete: async ({ task, prompt, system, maxTokens, temperature, signal }) => {
          const res = await llmRouter.complete({
            task,
            messages: [
              ...(system ? [{ role: "system" as const, content: system }] : []),
              { role: "user" as const, content: prompt },
            ],
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(signal ? { signal } : {}),
          });
          return res.content;
        },
      },
    }),
  });

  const adapter = registry.adapters[parsed.adapterId];
  if (!adapter) {
    await engram.shutdown();
    process.stderr.write(
      `cortex sync: adapter '${parsed.adapterId}' failed to initialize. Check logs above.\n`,
    );
    return 1;
  }

  try {
    const result = await runSync({
      adapter,
      engram,
      logger,
      llmRouter,
      opts: {
        ...(parsed.sinceIso ? { sinceIso: parsed.sinceIso } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.dryRun ? { dryRun: true } : {}),
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.errors > 0 ? 1 : 0;
  } finally {
    await registry.shutdown();
    await engram.shutdown();
  }
}

/**
 * Minimal no-op TaxonomyReader so AdapterContext compiles when we don't
 * load projects.yaml in sync mode. Proper taxonomy loading will land
 * when an adapter's classifier needs it.
 */
function emptyTaxonomyReader(): AdapterContext["taxonomy"] {
  return {
    listProjects: () => [],
    findProjectBySlug: () => undefined,
    findProject: () => undefined,
    listPeople: () => [],
    findPersonBySlug: () => undefined,
    findPersonByEmail: () => undefined,
    findPerson: () => undefined,
  };
}
