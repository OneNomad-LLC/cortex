/**
 * Destructive memory admin — export every row as JSONL, or wipe the
 * memories table. Used by pyre-web's danger-zone UI. Auth is already
 * verified by the dispatcher before this handler is reached.
 *
 * - GET  /api/admin/memory/export          — streams JSONL; ?embeddings=true&batchSize=N
 * - POST /api/admin/memory/wipe            — drops every row
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { sendJson } from "../http.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;

  // GET /api/admin/memory/export — streams every row as JSONL (one
  // record per line). Used by pyre-web's "Export memories" download
  // button so the user can pull their data out without going through
  // the cold-backup tarball path.
  if (req.method === "GET" && pathname === "/api/admin/memory/export") {
    const includeEmbedding =
      ctx.url.searchParams.get("embeddings") === "true";
    const batchSizeRaw = ctx.url.searchParams.get("batchSize");
    const batchSize = batchSizeRaw ? Number(batchSizeRaw) : undefined;
    try {
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="cortex-memories.jsonl"',
        "x-cortex-export-format": "jsonl",
        "x-cortex-export-includes-embedding": includeEmbedding ? "1" : "0",
      });
      let count = 0;
      for await (const row of ctx.opts.engram.exportAll({
        includeEmbedding,
        ...(batchSize !== undefined && Number.isFinite(batchSize)
          ? { batchSize }
          : {}),
      })) {
        res.write(JSON.stringify(row) + "\n");
        count++;
      }
      res.end();
      ctx.logger.info("api.memory.export_complete", { count, includeEmbedding });
    } catch (err) {
      ctx.logger.error("api.memory.export_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Headers may already be sent on a mid-stream failure — close the
      // connection rather than re-sending a JSON error envelope.
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        res.end();
      }
    }
    return true;
  }

  // POST /api/admin/memory/wipe — drops every row from the memories
  // table. Workspace config, projects, people, secrets are untouched.
  // Pyre-web's danger-zone button is the intended caller; a typed-
  // confirm dialog on the UI prevents accidental clicks.
  if (req.method === "POST" && pathname === "/api/admin/memory/wipe") {
    try {
      const result = await ctx.opts.engram.wipeAll();
      ctx.logger.warn("api.memory.wiped", { deleted: result.deleted });
      sendJson(res, 200, { ok: true, deleted: result.deleted });
    } catch (err) {
      ctx.logger.error("api.memory.wipe_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  return false;
}
