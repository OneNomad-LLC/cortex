/**
 * First-run setup probe. Tells the dashboard whether to show the
 * onboarding flow vs. the normal widget grid.
 *
 * "Configured" means: a workspace is active AND that workspace's
 * cortex.yaml has at least one enabled LLM provider. Adapters are
 * checked separately so the UI can prompt the user to enable one
 * without blocking the basic flow.
 *
 * - GET  /api/setup/state
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import { loadCortexConfig } from "../../config.js";
import { resolveConfigPath } from "../../cli/config-path.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (ctx.pathname !== "/api/setup/state") return false;

  try {
    const workspace = await getActiveWorkspace().catch(() => undefined);
    let hasLlmProvider = false;
    let enabledAdapters: string[] = [];
    if (workspace) {
      try {
        const cfg = await loadCortexConfig(resolveConfigPath());
        const providers = cfg.llm?.providers ?? {};
        hasLlmProvider = Object.values(providers).some(
          (p) => (p as { enabled?: boolean }).enabled === true,
        );
        enabledAdapters = Object.entries(cfg.adapters ?? {})
          .filter(([, entry]) => (entry as { enabled?: boolean }).enabled === true)
          .map(([id]) => id);
      } catch {
        // Config unreadable — treat as unconfigured.
      }
    }
    sendJson(res, 200, {
      workspace: workspace ? workspace.slug : null,
      workspacePath: workspace ? workspace.path : null,
      hasLlmProvider,
      enabledAdapters,
      needsSetup: !workspace || !hasLlmProvider,
    });
  } catch (err) {
    ctx.logger.warn("api.setup_state.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
