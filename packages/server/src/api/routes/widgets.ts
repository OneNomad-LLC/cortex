/**
 * Widget endpoints — list + invoke. Each widget is a pluggable JSON
 * payload that the dashboard renders. Per-request workspace resolution
 * (ADR-018 Phase 1b): the dashboard sends `?workspace=<slug>` so each
 * widget request can scope to the workspace the UI is currently viewing.
 *
 * - GET  /api/widgets               — catalog (name + description)
 * - GET  /api/widgets/:name         — invoke one widget; supports ?workspace=
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";
import { findWorkspace, getActiveWorkspace, type Workspace } from "../../cli/workspace/manager.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;

  if (req.method === "GET" && pathname === "/api/widgets") {
    sendJson(res, 200, {
      widgets: ctx.widgets.map((w) => ({
        name: w.name,
        description: w.description,
      })),
    });
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/widgets/")) {
    const name = pathname.slice("/api/widgets/".length);
    const widget = ctx.widgetsByName.get(name);
    if (!widget) {
      sendJson(res, 404, { error: `widget '${name}' not found` });
      return true;
    }

    const requestedSlug = ctx.url.searchParams.get("workspace")?.trim();
    let requestWorkspace: Workspace | undefined;
    if (requestedSlug) {
      requestWorkspace = await findWorkspace(requestedSlug);
      if (!requestWorkspace) {
        sendJson(res, 400, { error: `unknown workspace '${requestedSlug}'` });
        return true;
      }
    } else {
      requestWorkspace = await getActiveWorkspace().catch(() => undefined);
    }

    const started = Date.now();
    try {
      const payload = await widget.handler(ctx.url.searchParams, {
        ...ctx.widgetCtx,
        ...(requestWorkspace ? { workspace: requestWorkspace } : {}),
        logger: ctx.logger.child({
          widget: name,
          ...(requestWorkspace ? { workspace: requestWorkspace.slug } : {}),
        }),
      });
      ctx.logger.info("api.widget.ok", { widget: name, ms: Date.now() - started });
      sendJson(res, 200, payload);
    } catch (err) {
      ctx.logger.warn("api.widget.failed", {
        widget: name,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  return false;
}
