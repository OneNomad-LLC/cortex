/**
 * Manual adapter sync trigger. Uses the running adapter registry so it
 * picks up whatever config + secrets the server booted with. The
 * heartbeat tracks the run; the dashboard's Status page sees counters
 * update in real time.
 *
 * - POST /api/adapters/:id/sync
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import { runSync } from "../../sync.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const syncMatch = ctx.pathname.match(/^\/api\/adapters\/([^/]+)\/sync$/);
  if (!syncMatch || req.method !== "POST") return false;

  const adapterId = decodeURIComponent(syncMatch[1]!);
  const adapter = ctx.opts.adapters?.[adapterId];
  if (!adapter) {
    sendJson(res, 404, {
      error: `adapter '${adapterId}' not registered — enable it on /adapters first`,
    });
    return true;
  }

  const body = (await readJsonBody(req).catch(() => ({}))) as {
    sinceIso?: string;
    limit?: number;
    dryRun?: boolean;
  };

  ctx.opts.heartbeat?.markRunBegin(adapter.id);
  const startedAt = Date.now();
  ctx.logger.info("api.adapter.sync_begin", {
    adapter: adapter.id,
    sinceIso: body.sinceIso,
    limit: body.limit,
    dryRun: body.dryRun,
  });

  try {
    const result = await runSync({
      adapter,
      engram: ctx.opts.engram,
      logger: ctx.logger,
      ...(ctx.opts.llmRouter ? { llmRouter: ctx.opts.llmRouter } : {}),
      taxonomy: ctx.opts.taxonomy,
      opts: {
        ...(body.sinceIso ? { sinceIso: body.sinceIso } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      },
    });
    const durationMs = Date.now() - startedAt;
    ctx.opts.heartbeat?.markRunEnd(adapter.id, {
      ingested: result.ingested,
      errors: result.errors,
      durationMs,
    });
    ctx.logger.info("api.adapter.sync_done", {
      adapter: adapter.id,
      durationMs,
      ...result,
    });
    sendJson(res, 200, { ok: true, durationMs, ...result });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    ctx.opts.heartbeat?.markRunEnd(adapter.id, {
      ingested: 0,
      errors: 1,
      durationMs,
    });
    ctx.logger.error("api.adapter.sync_failed", {
      adapter: adapter.id,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      ok: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
