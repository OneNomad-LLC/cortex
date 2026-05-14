/**
 * Public health probe. The only route that bypasses auth — Fly's machine
 * health probe (and any upstream load balancer) hits it without secrets.
 *
 * - GET  /health
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (req.method === "GET" && ctx.pathname === "/health") {
    sendJson(res, 200, { ok: true, version: 1, widgets: ctx.widgets.length });
    return true;
  }
  return false;
}
