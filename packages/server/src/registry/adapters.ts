import type {
  AdapterContext,
  AdapterFactory,
  Logger,
  SourceAdapter,
} from "@onenomad/przm-cortex-core";
import { createAdapter as createBitbucketAdapter } from "@onenomad/przm-cortex-adapter-bitbucket";
import { createAdapter as createConfluenceAdapter } from "@onenomad/przm-cortex-adapter-confluence";
import { createAdapter as createGithubAdapter } from "@onenomad/przm-cortex-adapter-github";
import { createAdapter as createJiraAdapter } from "@onenomad/przm-cortex-adapter-jira";
import { createAdapter as createLinearAdapter } from "@onenomad/przm-cortex-adapter-linear";
import { createAdapter as createLoomAdapter } from "@onenomad/przm-cortex-adapter-loom";
import { createAdapter as createNotionAdapter } from "@onenomad/przm-cortex-adapter-notion";
import { createAdapter as createObsidianAdapter } from "@onenomad/przm-cortex-adapter-obsidian";
import { createAdapter as createSlackAdapter } from "@onenomad/przm-cortex-adapter-slack";
import type { CortexConfig } from "../config.js";

/**
 * Static registry of adapter factories. When a new adapter package lands,
 * import it and add it here. ADR-009: static imports, not dynamic
 * `require()` — keeps the TypeScript check honest.
 */
const adapterFactories: Record<string, AdapterFactory> = {
  "@onenomad/przm-cortex-adapter-bitbucket": createBitbucketAdapter,
  "@onenomad/przm-cortex-adapter-confluence": createConfluenceAdapter,
  "@onenomad/przm-cortex-adapter-github": createGithubAdapter,
  "@onenomad/przm-cortex-adapter-jira": createJiraAdapter,
  "@onenomad/przm-cortex-adapter-linear": createLinearAdapter,
  "@onenomad/przm-cortex-adapter-loom": createLoomAdapter,
  "@onenomad/przm-cortex-adapter-notion": createNotionAdapter,
  "@onenomad/przm-cortex-adapter-obsidian": createObsidianAdapter,
  "@onenomad/przm-cortex-adapter-slack": createSlackAdapter,
};

/**
 * Look up an adapter factory by the short id used in wizard specs
 * (e.g. `github` → `@onenomad/przm-cortex-adapter-github`). The wizard registry
 * and the adapter registry use different keying (wizard id vs.
 * package name), so we map at the boundary.
 */
export function factoryByWizardId(
  wizardId: string,
): AdapterFactory | undefined {
  return adapterFactories[`@onenomad/przm-cortex-adapter-${wizardId}`];
}

export interface AdapterRegistry {
  adapters: Record<string, SourceAdapter>;
  shutdown(): Promise<void>;
}

/**
 * Build the adapter registry from cortex.yaml. For each enabled adapter:
 *   1. Look up its factory by `package` name
 *   2. Validate its config block with the factory's own Zod schema
 *   3. Verify every `requiredSecrets` entry is in the environment
 *   4. Invoke `adapter.init(ctx)`
 *
 * Adapters that fail validation are logged and skipped — one bad adapter
 * shouldn't take down the rest.
 */
export async function buildAdapterRegistry(args: {
  cfg: CortexConfig;
  env: Record<string, string | undefined>;
  logger: Logger;
  buildContext: (adapterId: string, entryConfig: Record<string, unknown>, secrets: Record<string, string>) => AdapterContext;
}): Promise<AdapterRegistry> {
  const { cfg, env, logger } = args;
  const adapters: Record<string, SourceAdapter> = {};

  for (const [id, entry] of Object.entries(cfg.adapters)) {
    if (!entry.enabled) {
      logger.info("adapter.skipped", { id, reason: "disabled" });
      continue;
    }

    const factory = adapterFactories[entry.package];
    if (!factory) {
      logger.warn("adapter.unknown_package", { id, package: entry.package });
      continue;
    }

    try {
      const adapter = factory();

      // 1. Config shape
      const parsedConfig = adapter.configSchema.parse(entry.config) as Record<
        string,
        unknown
      >;

      // 2. Required secrets
      const secrets: Record<string, string> = {};
      const missing: string[] = [];
      for (const name of adapter.requiredSecrets) {
        const val = env[name];
        if (!val) missing.push(name);
        else secrets[name] = val;
      }
      if (missing.length > 0) {
        logger.warn("adapter.missing_secrets", { id, missing });
        continue;
      }

      // 3. Context + init
      const ctx = args.buildContext(id, parsedConfig, secrets);
      await adapter.init(ctx);

      adapters[id] = adapter;
      logger.info("adapter.ready", {
        id,
        package: entry.package,
        pipelines: [...adapter.pipelines],
      });
    } catch (err) {
      logger.error("adapter.init_failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    adapters,
    async shutdown() {
      for (const [id, adapter] of Object.entries(adapters)) {
        try {
          await adapter.shutdown();
        } catch (err) {
          logger.warn("adapter.shutdown_failed", {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}
