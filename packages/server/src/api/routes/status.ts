/**
 * Live health + uptime + per-adapter sync state. Reads straight from
 * the in-process HeartbeatWriter so the dashboard sees up-to-the-second
 * numbers — the on-disk file only flushes every 60s.
 *
 * - GET  /api/status
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (ctx.pathname !== "/api/status") return false;

  try {
    if (!ctx.opts.heartbeat) {
      sendJson(res, 200, { running: false });
      return true;
    }
    const snap = ctx.opts.heartbeat.snapshot();
    sendJson(res, 200, { running: true, ...snap });
  } catch (err) {
    ctx.logger.warn("api.status.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
