/**
 * Cold-storage backup endpoints. Dump returns the entire PGlite data
 * directory as a gzipped tarball; restore accepts one and queues a
 * machine reboot (Fly's restart policy brings it back up and the boot
 * path picks up the marker).
 *
 * - POST /api/admin/backup/dump        — returns gzipped PGlite data dir
 * - POST /api/admin/backup/restore     — queues restore + exits process
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

  // POST /api/admin/backup/restore — stages an uploaded tarball next to
  // the PGlite data dir and triggers a process exit. Fly's restart
  // policy brings the machine back up; the boot path detects the
  // marker, wipes the data dir, and initializes PGlite from the
  // tarball. Brief downtime (~30s) but no PGlite-reload complications.
  if (req.method === "POST" && pathname === "/api/admin/backup/restore") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        sendJson(res, 400, { error: "empty body" });
        return true;
      }
      const { mkdir, writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const os = await import("node:os");
      const dataDir = path.join(os.homedir(), ".cortex", "data", "pglite");
      const marker = `${dataDir}.restore-pending.tar.gz`;
      await mkdir(path.dirname(marker), { recursive: true });
      await writeFile(marker, buf);
      sendJson(res, 202, {
        accepted: true,
        marker,
        bytes: buf.length,
        message:
          "restore queued; process will exit after this response and Fly's restart policy will boot a fresh machine that picks up the tarball",
      });
      // Defer exit until the response is flushed.
      setTimeout(() => {
        ctx.logger.warn("api.backup.restore_exiting", {
          marker,
          bytes: buf.length,
        });
        process.exit(0);
      }, 250).unref();
    } catch (err) {
      ctx.logger.error("api.backup.restore_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  // POST /api/admin/backup/dump — returns the entire PGlite data
  // directory as gzipped tar in the response body. External-pool
  // deployments don't implement dumpDataDir and respond 501 so the
  // caller can skip and use pg_dump instead.
  if (req.method === "POST" && pathname === "/api/admin/backup/dump") {
    const dump = ctx.opts.engram.dumpDataDir;
    if (typeof dump !== "function") {
      sendJson(res, 501, {
        error:
          "this deployment uses an external Postgres backend; cold-storage dumps via PGlite are not available. Use pg_dump against the configured connectionString.",
      });
      return true;
    }
    try {
      const blob = await dump.call(ctx.opts.engram);
      const buf = Buffer.from(await blob.arrayBuffer());
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(buf.length),
        "x-cortex-backup-version": "1",
        "x-cortex-backup-format": "pglite-tar-gz",
      });
      res.end(buf);
    } catch (err) {
      ctx.logger.error("api.backup.dump_failed", {
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
