/**
 * Manual hot-reload trigger. The dashboard fires this after the user
 * edits config via a wizard, toggles an adapter, etc. — but the route
 * handlers that mutate config call tryReload() inline too, so this is
 * mainly for cases where the user knows they changed env vars or
 * something outside the dashboard's mutation surface.
 *
 * - POST /api/reload
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";
import { tryReload } from "../reload.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (req.method !== "POST" || ctx.pathname !== "/api/reload") return false;

  const reloaded = await tryReload(ctx.opts, ctx.logger);
  if (reloaded === false) {
    sendJson(res, 503, {
      error:
        "hot reload not wired in this build — restart the container to apply config changes",
    });
    return true;
  }
  sendJson(res, 200, { reloaded: true, detail: reloaded });
  return true;
}
