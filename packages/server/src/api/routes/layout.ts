/**
 * Dashboard layout — what widgets to render and in what arrangement.
 * Re-reads `dashboard.yaml` on every request so users can edit the
 * template without bouncing the server.
 *
 * - GET  /api/layout
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";
import {
  type DashboardLayout,
  loadDashboardLayout,
  resolveLayout,
} from "../layout.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (req.method !== "GET" || ctx.pathname !== "/api/layout") return false;

  try {
    const raw: DashboardLayout = ctx.opts.layoutPath
      ? await loadDashboardLayout(ctx.opts.layoutPath)
      : { role: "delivery", widgets: [] };
    const resolved = resolveLayout(raw);
    // Surface the active workspace slug so the dashboard header can
    // render which bundle of config is driving the UI. Undefined means
    // the user hasn't adopted workspaces yet — the dashboard hides
    // the badge in that case.
    const workspace = await getActiveWorkspace().catch(() => undefined);
    sendJson(res, 200, {
      ...resolved,
      ...(workspace ? { workspace: workspace.slug } : {}),
    });
  } catch (err) {
    ctx.logger.warn("api.layout.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
