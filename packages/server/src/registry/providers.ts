import type {
  LLMProvider,
  LLMProviderFactory,
  LLMRouterConfig,
} from "@onenomad/cortex-llm-core";
import { LLMRouter } from "@onenomad/cortex-llm-core";
import { createOllamaProvider } from "@onenomad/cortex-provider-ollama";
import { createOpenRouterProvider } from "@onenomad/cortex-provider-openrouter";
import type { Logger } from "@onenomad/cortex-core";
import type { CortexConfig } from "../config.js";

/**
 * Static registry of provider factories known to this server. Adding a new
 * provider = install the package, add it here, add a config entry.
 *
 * Static imports (not dynamic require) so TypeScript type-checks every
 * provider against LLMProvider at compile time. See ADR-009.
 */
const providerFactories: Record<string, LLMProviderFactory> = {
  "@onenomad/cortex-provider-ollama": createOllamaProvider,
  "@onenomad/cortex-provider-openrouter": createOpenRouterProvider,
};

/**
 * Load enabled providers from config, verify required secrets are present,
 * init each, and return a router wired to them.
 */
export async function buildLLMRouter(args: {
  cfg: CortexConfig;
  env: Record<string, string | undefined>;
  logger: Logger;
}): Promise<{
  router: LLMRouter;
  providers: Record<string, LLMProvider>;
}> {
  const { cfg, env, logger } = args;
  const providers: Record<string, LLMProvider> = {};

  for (const [id, entry] of Object.entries(cfg.llm.providers)) {
    if (!entry.enabled) {
      logger.info("provider.skipped", { id, reason: "disabled" });
      continue;
    }

    const factory = providerFactories[entry.package];
    if (!factory) {
      throw new Error(
        `Provider '${id}' references unknown package '${entry.package}'. ` +
          `Register it in registry/providers.ts.`,
      );
    }

    // Probe the provider's required secrets via a dry-run factory call.
    // Providers pull from `secrets` by name; anything missing will surface
    // at construction time (or on first use).
    const provider = factory({ config: entry.config, secrets: filterSecrets(env) });

    await provider.init();
    providers[id] = provider;
    logger.info("provider.ready", {
      id,
      package: entry.package,
      model: provider.version,
    });
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
  return { router, providers };
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
