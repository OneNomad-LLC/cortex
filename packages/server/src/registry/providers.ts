import type {
  LLMProvider,
  LLMProviderFactory,
  LLMRouterConfig,
} from "@onenomad/cortex-llm-core";
import { LLMRouter } from "@onenomad/cortex-llm-core";
import type { Logger } from "@onenomad/cortex-core";
import type { CortexConfig } from "../config.js";

/**
 * Lazy registry of provider factories. Cortex 0.2 — provider
 * packages moved to `optionalDependencies` so the data plane works
 * without an LLM. Each factory is loaded on demand; if the package
 * isn't installed the import fails and that provider is logged-and-
 * skipped rather than crashing startup.
 *
 * Adding a new provider = install the package, add a loader here,
 * add a config entry. See ADR-009.
 */
const providerLoaders: Record<
  string,
  () => Promise<LLMProviderFactory>
> = {
  "@onenomad/cortex-provider-ollama": async () => {
    const mod = await import("@onenomad/cortex-provider-ollama");
    return mod.createOllamaProvider;
  },
  "@onenomad/cortex-provider-openrouter": async () => {
    const mod = await import("@onenomad/cortex-provider-openrouter");
    return mod.createOpenRouterProvider;
  },
};

/**
 * Result of `buildLLMRouter`. `router` is undefined when no provider
 * is configured — pipelines and adapters must check before using.
 */
export interface LLMRouterBootstrap {
  router?: LLMRouter;
  providers: Record<string, LLMProvider>;
  /** True when at least one provider initialized successfully. */
  hasLocalLlm: boolean;
}

/**
 * Load enabled providers from config, verify required secrets are present,
 * init each, and return a router wired to them.
 *
 * Cortex 0.2 — returns `{ hasLocalLlm: false }` instead of throwing
 * when no providers are configured or installed. Callers fall back
 * to the enrichment queue (MCP-client-driven enrichment).
 */
export async function buildLLMRouter(args: {
  cfg: CortexConfig;
  env: Record<string, string | undefined>;
  logger: Logger;
}): Promise<LLMRouterBootstrap> {
  const { cfg, env, logger } = args;
  const providers: Record<string, LLMProvider> = {};

  for (const [id, entry] of Object.entries(cfg.llm.providers)) {
    if (!entry.enabled) {
      logger.info("provider.skipped", { id, reason: "disabled" });
      continue;
    }

    const loader = providerLoaders[entry.package];
    if (!loader) {
      logger.warn("provider.unknown_package", {
        id,
        package: entry.package,
        hint: "register a loader in registry/providers.ts",
      });
      continue;
    }

    let factory: LLMProviderFactory;
    try {
      factory = await loader();
    } catch (err) {
      logger.warn("provider.package_missing", {
        id,
        package: entry.package,
        hint: "install the optionalDependency or disable this provider in cortex.yaml",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    try {
      const provider = factory({
        config: entry.config,
        secrets: filterSecrets(env),
      });
      await provider.init();
      providers[id] = provider;
      logger.info("provider.ready", {
        id,
        package: entry.package,
        model: provider.version,
      });
    } catch (err) {
      logger.warn("provider.init_failed", {
        id,
        package: entry.package,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  if (Object.keys(providers).length === 0) {
    logger.warn("llm.no_providers", {
      hint:
        "Running without enrichment. Connect an MCP client (Pyre, Claude " +
        "Desktop) to enable structured enrichment via the Cortex " +
        "Enrichment Protocol — see docs/enrichment-protocol.md.",
    });
    return { providers, hasLocalLlm: false };
  }

  const tasks = cfg.llm.tasks as LLMRouterConfig["tasks"];
  const routerCfg: LLMRouterConfig = {
    providers,
    tasks,
    fallbackChain: cfg.llm.fallbackChain,
    logger: {
      warn: (msg, meta) => logger.warn(msg, meta),
      info: (msg, meta) => logger.info(msg, meta),
    },
  };

  const router = new LLMRouter(routerCfg);
  return { router, providers, hasLocalLlm: true };
}

function filterSecrets(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
