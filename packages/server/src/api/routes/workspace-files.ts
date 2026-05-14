/**
 * Workspace-file editors — read/write projects.yaml and people.yaml via
 * the dashboard instead of forcing the user into a text editor.
 *
 * `:name` is limited to `projects` / `people` — anything else 404s
 * because we don't want this surface to become a generic filesystem
 * writer. Writes go to the `.local.yaml` overlay when one exists so
 * edits survive base-config changes.
 *
 * - GET  /api/workspace-files/:name   — raw YAML content
 * - PUT  /api/workspace-files/:name   — write back; rejects invalid YAML
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import { resolveLocalFirst } from "../../config.js";
import { resolveConfigPath } from "../../cli/config-path.js";
import { tryReload } from "../reload.js";

const ALLOWED = new Set(["projects", "people"]);

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/workspace-files/")) return false;

  const match = ctx.pathname.match(/^\/api\/workspace-files\/([^/]+)$/);
  if (!match) {
    sendJson(res, 404, { error: "not found" });
    return true;
  }
  const name = decodeURIComponent(match[1]!);
  if (!ALLOWED.has(name)) {
    sendJson(res, 400, {
      error: `workspace file '${name}' not editable from the dashboard`,
    });
    return true;
  }

  const cfgPath = resolveConfigPath();
  const dir = path.dirname(cfgPath);
  const filePath = await resolveLocalFirst(path.join(dir, `${name}.yaml`));

  try {
    if (req.method === "GET") {
      const content = await readFile(filePath, "utf8").catch(() => "");
      sendJson(res, 200, { path: filePath, content });
      return true;
    }

    if (req.method === "PUT") {
      const body = (await readJsonBody(req)) as { content?: unknown } | null;
      const content =
        body && typeof body.content === "string" ? body.content : "";
      // Parse to validate — writing invalid YAML would brick startup.
      try {
        parseYaml(content);
      } catch (err) {
        sendJson(res, 400, {
          error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        });
        return true;
      }
      await writeFile(filePath, content, "utf8");
      const reloaded = await tryReload(ctx.opts, ctx.logger);
      ctx.logger.info("api.workspace_files.wrote", {
        name,
        path: filePath,
        reloaded,
      });
      sendJson(res, 200, { path: filePath, bytes: content.length, reloaded });
      return true;
    }

    sendJson(res, 405, { error: "method not allowed" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.workspace_files.failed", {
      method: req.method,
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
