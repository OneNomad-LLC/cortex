/**
 * Log viewing endpoints. The recent endpoint serves the in-memory ring
 * buffer; the stream endpoint pushes new lines as SSE. The dashboard
 * hits recent first to backfill, then subscribes to the stream for live
 * updates — the stream doesn't replay history on connect.
 *
 * - GET  /api/logs            — recent ring buffer (default 500, max 2000)
 * - GET  /api/logs/stream     — SSE: every new line as `data: <json>\n\n`
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";
import { getSharedLogBus, type LogLine } from "../../log-bus.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (ctx.pathname === "/api/logs") {
    const limitRaw = ctx.url.searchParams.get("limit");
    const limit = limitRaw
      ? Math.max(1, Math.min(2000, Number(limitRaw)))
      : 500;
    const lines = getSharedLogBus().recent(limit);
    sendJson(res, 200, { lines });
    return true;
  }

  if (ctx.pathname === "/api/logs/stream") {
    handleStream(req, res, ctx);
    return true;
  }

  return false;
}

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Preamble so proxies that sniff the first chunk see something.
  res.write(": connected\n\n");

  const bus = getSharedLogBus();
  const onLine = (line: LogLine): void => {
    try {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      // Writing after the client disconnected throws; cleanup runs below.
    }
  };
  bus.on("line", onLine);

  // 15s keepalive so idle proxies don't close the connection.
  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      // ignored — cleanup handles disconnects
    }
  }, 15_000);
  keepalive.unref?.();

  req.on("close", () => {
    clearInterval(keepalive);
    bus.off("line", onLine);
    ctx.logger.debug("api.logs.stream_closed");
  });
}
