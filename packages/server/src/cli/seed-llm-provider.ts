import {
  applyWizardResult,
  setDefaultLlmTask,
  setUseLocalEmbedder,
} from "./config-mutation.js";
import { getActiveWorkspace } from "./workspace/manager.js";
import type { Logger } from "@onenomad/przm-cortex-core";

/**
 * Seed an LLM provider config from environment variables. The intended
 * caller is the Cortex Cloud startup path on Fly — pyre-web's deploy
 * action stamps an OPENROUTER_API_KEY (and optional base URL + default
 * model) onto the per-tenant Fly machine, and a freshly provisioned
 * tenant comes up with enrichment-capable LLM routing already wired.
 *
 * Without this seed, every new tenant deploys with the bootstrap
 * `cortex.yaml` — empty providers, default task pointing at
 * `anthropic/claude-haiku-4.5` — and an operator has to SSH in,
 * apply the openrouter wizard, edit the task model, and restart.
 * That's not a product; it's a per-customer science project.
 *
 * Idempotent: re-running on a populated workspace re-applies the
 * wizard config (overwriting `cortex.local.yaml` provider block) and
 * re-stamps the default task. If the tenant has since edited their
 * provider config via the dashboard wizard, this overwrites it on
 * next restart — that's the right tradeoff because the env vars
 * are the source of truth for managed deployments.
 *
 * Env contract:
 *   OPENROUTER_API_KEY       required to fire the seed
 *   PRZM_CORTEX_LLM_BASE_URL      optional — defaults to OpenRouter's URL
 *                             when unset. For Azure OpenAI, set:
 *                             https://<resource>.openai.azure.com/openai/v1
 *   PRZM_CORTEX_LLM_DEFAULT_MODEL optional — defaults to the OpenRouter
 *                             package's bootstrap default. For Azure
 *                             set the deployment name (e.g. `gpt-4o-mini`).
 *
 * No-op when OPENROUTER_API_KEY is unset — self-hosted Cortex installs
 * keep the existing dashboard-wizard flow.
 */
export async function seedLlmProviderFromEnv(logger: Logger): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return;

  const baseUrl = process.env.PRZM_CORTEX_LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
  const defaultModel =
    process.env.PRZM_CORTEX_LLM_DEFAULT_MODEL ?? "anthropic/claude-haiku-4.5";

  const workspace = await getActiveWorkspace();
  if (!workspace) {
    logger.warn("seed_llm_provider.no_active_workspace", {
      hint: "OPENROUTER_API_KEY is set but no active workspace exists yet — seed will run on the next startup once a workspace is created.",
    });
    return;
  }

  try {
    const provided = await applyWizardResult(
      { repoRoot: workspace.path },
      {
        moduleId: "openrouter",
        category: "provider",
        config: {
          baseUrl,
          appTitle: "Cortex",
          referer: "https://pyre.sh",
        },
        secrets: { OPENROUTER_API_KEY: apiKey },
      },
    );
    const tasked = await setDefaultLlmTask({
      repoRoot: workspace.path,
      provider: "openrouter",
      model: defaultModel,
      tasks: ["default", "structural", "synthesis", "brief", "classify", "extract"],
    });
    // Force local Xenova embeddings. The provider behind the
    // openrouter shim is almost always a chat-only model (Azure
    // gpt-4o-mini, Anthropic Claude, etc.) — none of which support
    // the OpenAI embeddings API. Without this, kb_search blows up.
    // Operators who have a real embedding model configured can flip
    // this off via the dashboard wizard later.
    const embed = await setUseLocalEmbedder({
      repoRoot: workspace.path,
      value: true,
    });
    // Make the secret visible to the in-process provider router that
    // boots after this — without this, the LLM router would build
    // with `apiKey: undefined` and fail every completion until the
    // next process restart.
    process.env.OPENROUTER_API_KEY = apiKey;
    logger.info("seed_llm_provider.applied", {
      provider: "openrouter",
      baseUrl,
      defaultModel,
      filesWritten: [
        ...provided.filesWritten,
        ...tasked.filesWritten,
        ...embed.filesWritten,
      ],
    });
  } catch (err) {
    logger.warn("seed_llm_provider.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
