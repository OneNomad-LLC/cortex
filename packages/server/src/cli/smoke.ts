import { loadCortexConfig, type CortexConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { buildLLMRouter } from "../registry/providers.js";
import { resolveConfigPath } from "./config-path.js";

export async function runSmoke(): Promise<number> {
  const logger = createLogger({ component: "smoke" });
  const cfgPath = resolveConfigPath();

  const cfg = await loadCortexConfig(cfgPath);
  const { providers } = await buildLLMRouter({
    cfg,
    env: process.env,
    logger,
  });

  const enabledIds = Object.keys(providers);
  if (enabledIds.length === 0) {
    logger.error("smoke.no_providers", {
      hint: "enable at least one provider in config/cortex.yaml",
    });
    return 1;
  }

  let failed = 0;

  for (const id of enabledIds) {
    const provider = providers[id];
    if (!provider) continue;

    const health = await provider.healthCheck();
    logger.info("smoke.health", { id, ...health });
    if (!health.healthy) {
      failed++;
      continue;
    }

    let model = defaultModelFor(cfg, id);
    if (!model && provider.listModels) {
      const models = await provider.listModels();
      model = models[0];
    }
    if (!model) {
      logger.warn("smoke.no_model", { id });
      failed++;
      continue;
    }

    try {
      const res = await provider.complete({
        model,
        messages: [
          { role: "user", content: "Reply with just: OK" },
        ],
        maxTokens: 16,
        temperature: 0,
      });
      logger.info("smoke.ok", {
        id,
        model,
        latencyMs: res.latencyMs,
        preview: res.content.slice(0, 80),
        usage: res.usage,
      });
    } catch (err) {
      logger.error("smoke.fail", {
        id,
        model,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    } finally {
      await provider.shutdown();
    }
  }

  return failed > 0 ? 1 : 0;
}

function defaultModelFor(
  cfg: CortexConfig,
  providerId: string,
): string | undefined {
  const byDefault = cfg.llm.tasks.default;
  if (byDefault && byDefault.provider === providerId) return byDefault.model;
  for (const binding of Object.values(cfg.llm.tasks)) {
    if (binding.provider === providerId) return binding.model;
  }
  return undefined;
}
