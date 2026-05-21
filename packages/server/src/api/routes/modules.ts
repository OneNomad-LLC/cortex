/**
 * Private-module management — the dashboard's Modules page. Mirrors
 * `cortex module install / list / remove` on the CLI. A restart is
 * required for new/removed modules to take effect; the loader only
 * runs at boot. The GET response flags each entry's filesystem state
 * (`ready` / `not-built` / `missing`) so the UI can show what the user
 * is actually looking at.
 *
 * - GET    /api/modules            — list with on-disk status
 * - POST   /api/modules/install    — install; streams SSE progress + final event
 * - DELETE /api/modules/:name      — unregister (keeps files on disk)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import { resolveConfigPath } from "../../cli/config-path.js";
import {
  listPrivateModulesFromConfig,
  removePrivateModule,
} from "../../cli/config-mutation.js";
import {
  installModule,
  type InstallEvent,
} from "../../cli/module-install.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (pathname !== "/api/modules" && !pathname.startsWith("/api/modules/")) {
    return false;
  }

  try {
    if (req.method === "GET" && pathname === "/api/modules") {
      const repoRoot = path.dirname(path.dirname(resolveConfigPath()));
      const registered = await listPrivateModulesFromConfig({ repoRoot });
      const rows = registered.map((containerPath) => {
        const hostPath = toHostPathGuess(containerPath);
        const present = existsSync(hostPath);
        const distPresent = existsSync(path.join(hostPath, "dist", "index.js"));
        return {
          name: path.basename(containerPath),
          containerPath,
          hostPath,
          status: !present
            ? ("missing" as const)
            : !distPresent
              ? ("not-built" as const)
              : ("ready" as const),
        };
      });
      sendJson(res, 200, { modules: rows });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/modules/install") {
      const body = (await readJsonBody(req)) as {
        source?: string;
        name?: string;
        noBuild?: boolean;
        pathOnly?: boolean;
        native?: boolean;
      } | null;
      if (!body?.source || typeof body.source !== "string") {
        sendJson(res, 400, { error: "body.source required" });
        return true;
      }

      // Stream progress over Server-Sent Events. Dashboard shows a live
      // log while the install runs — git clone + pnpm build can take a
      // couple minutes, HTTP idle timeouts would kill a plain JSON response.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const writeEvent = (
        event: string,
        data: Record<string, unknown>,
      ): void => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      ctx.logger.info("api.modules.install.begin", {
        source: body.source,
        name: body.name,
      });
      let closed = false;
      req.on("close", () => {
        closed = true;
      });
      const onProgress = (evt: InstallEvent): void => {
        if (closed) return;
        writeEvent(evt.type, evt);
      };
      try {
        const result = await installModule({
          source: body.source,
          ...(body.name ? { name: body.name } : {}),
          ...(body.noBuild ? { noBuild: true } : {}),
          ...(body.pathOnly ? { pathOnly: true } : {}),
          ...(body.native ? { native: true } : {}),
          onProgress,
        });
        if (!closed) {
          writeEvent("done", { ...result });
          res.end();
        }
        ctx.logger.info("api.modules.install.done", {
          name: result.name,
          ok: result.ok,
        });
      } catch (err) {
        if (!closed) {
          writeEvent("error", {
            error: err instanceof Error ? err.message : String(err),
          });
          res.end();
        }
        ctx.logger.warn("api.modules.install.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    const removeMatch = pathname.match(/^\/api\/modules\/([^/]+)$/);
    if (req.method === "DELETE" && removeMatch) {
      const target = decodeURIComponent(removeMatch[1]!);
      const repoRoot = path.dirname(path.dirname(resolveConfigPath()));
      const current = await listPrivateModulesFromConfig({ repoRoot });
      const match =
        current.find((p) => p === target) ??
        current.find((p) => path.basename(p) === target);
      if (!match) {
        sendJson(res, 404, {
          error: `module '${target}' isn't registered`,
          known: current.map((p) => path.basename(p)),
        });
        return true;
      }
      const { filePath, removed } = await removePrivateModule(
        { repoRoot },
        match,
      );
      ctx.logger.info("api.modules.removed", {
        target: match,
        removed,
        filePath,
      });
      sendJson(res, 200, {
        ok: removed,
        removed: match,
        configPath: filePath,
        warning:
          "Files on disk were NOT deleted. Restart cortex to pick up the removal.",
      });
      return true;
    }

    sendJson(res, 405, { error: "method not allowed" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.modules.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Best-effort host-path reconstruction for the GET /api/modules
 * response. Mirrors the convention used by `cortex module install`:
 * modules installed under $PRZM_CORTEX_HOME_HOST/modules/<name> appear
 * inside the container at /root/.cortex/modules/<name>. Anything
 * outside that root returns the container path as-is — the UI shows
 * "host path unknown" when it differs.
 */
function toHostPathGuess(containerPath: string): string {
  const normalized = containerPath.replace(/\\/g, "/");
  const cRoot = "/root/.cortex/modules";
  if (normalized.startsWith(cRoot)) {
    const rel = normalized.slice(cRoot.length).replace(/^\/+/, "");
    const hostRoot = process.env.PRZM_CORTEX_HOME_HOST
      ? path.resolve(process.env.PRZM_CORTEX_HOME_HOST, "modules")
      : path.resolve("./.cortex-data", "modules");
    return path.join(hostRoot, rel);
  }
  return containerPath;
}
