/**
 * Workspace management — list, create, switch, delete. A workspace is
 * a named config bundle on disk; switching changes which one cortex
 * loads at boot.
 *
 * - GET    /api/workspaces                       — list with active marker
 * - POST   /api/workspaces                       — create (and optionally activate)
 * - POST   /api/workspaces/switch                — flip the active pointer
 * - DELETE /api/workspaces/:slug?confirm=true    — destructive removal
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import {
  createWorkspace,
  findWorkspace,
  listWorkspaces,
  removeWorkspace,
  switchWorkspace,
  validateSlug,
} from "../../cli/workspace/manager.js";
import { readState } from "../../cli/workspace/state.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (pathname !== "/api/workspaces" && !pathname.startsWith("/api/workspaces/")) {
    return false;
  }

  try {
    if (req.method === "GET" && pathname === "/api/workspaces") {
      const [workspaces, state] = await Promise.all([
        listWorkspaces(),
        readState(),
      ]);
      sendJson(res, 200, {
        active: state.activeWorkspace ?? null,
        workspaces: workspaces.map((w) => ({
          slug: w.slug,
          path: w.path,
          active: state.activeWorkspace === w.slug,
        })),
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/workspaces/switch") {
      const body = (await readJsonBody(req)) as { slug?: string };
      if (!body.slug) {
        sendJson(res, 400, { error: "body.slug required" });
        return true;
      }
      const ws = await switchWorkspace(body.slug);
      sendJson(res, 200, {
        slug: ws.slug,
        path: ws.path,
        warning:
          "State updated. Restart `cortex start` so the running daemon loads this workspace's memory and config.",
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/workspaces") {
      const body = (await readJsonBody(req)) as {
        slug?: string;
        fromPath?: string;
        activate?: boolean;
      };
      if (!body.slug) {
        sendJson(res, 400, { error: "body.slug required" });
        return true;
      }
      const validated = validateSlug(body.slug);
      if (!validated.ok) {
        sendJson(res, 400, { error: validated.reason });
        return true;
      }
      const ws = await createWorkspace({
        slug: body.slug,
        ...(body.fromPath ? { fromPath: body.fromPath } : {}),
      });
      const state = await readState();
      let activated = false;
      if (!state.activeWorkspace || body.activate) {
        await switchWorkspace(ws.slug);
        activated = true;
      }
      sendJson(res, 201, { slug: ws.slug, path: ws.path, activated });
      return true;
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/workspaces/")) {
      const slug = decodeURIComponent(pathname.slice("/api/workspaces/".length));
      const confirm = ctx.url.searchParams.get("confirm") === "true";
      if (!confirm) {
        sendJson(res, 400, {
          error:
            "destructive — pass ?confirm=true to delete the workspace directory",
        });
        return true;
      }
      const existing = await findWorkspace(slug);
      if (!existing) {
        sendJson(res, 404, { error: `workspace '${slug}' not found` });
        return true;
      }
      await removeWorkspace(slug);
      sendJson(res, 200, { slug, removed: true });
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.workspaces.failed", {
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
