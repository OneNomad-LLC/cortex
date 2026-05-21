/**
 * `/api/dashboard/workspaces` — list, switch, create. Wraps the CLI
 * workspace manager so the dashboard can:
 *
 *   - render the workspace switcher in the top bar
 *   - hot-switch the dashboard session's bound workspace (without
 *     touching the CLI's global active pointer)
 *   - create new workspaces from the UI (with optional seed path)
 *
 * Surface:
 *   GET  /api/dashboard/workspaces
 *     → { workspaces: Array<{ slug, isActive }> }
 *   POST /api/dashboard/workspaces/switch    body { slug }
 *     → 200 { ok: true, workspace } | 404 unknown_slug
 *   POST /api/dashboard/workspaces/create    body { slug, fromPath? }
 *     → 201 { ok: true, workspace: { slug, path } } | 409 already_exists
 *
 * All routes are gated by `requireDashboardAuth(["admin"])` —
 * workspace selection is a privileged action because it determines
 * which secrets and which memory the dashboard sees.
 *
 * The "is active" marker comes from the BROWSING SESSION'S bound
 * workspace (the one set via `setDashboardSession`), not the
 * filesystem-wide `state.json` pointer. That keeps two dashboard
 * tabs from clobbering each other.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import {
  createWorkspace,
  findWorkspace,
  listWorkspaces,
  validateSlug,
} from "../../cli/workspace/manager.js";
import { setDashboardSession } from "../../session-context.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (
    pathname !== "/api/dashboard/workspaces" &&
    !pathname.startsWith("/api/dashboard/workspaces/")
  ) {
    return false;
  }

  const gate = requireDashboardAuth(["admin"]);

  try {
    if (req.method === "GET" && pathname === "/api/dashboard/workspaces") {
      const resolved = await gate(req, res);
      if (!resolved) return true;
      const all = await listWorkspaces();
      const activeSlug = resolved.session.workspace ?? null;
      sendJson(res, 200, {
        workspaces: all.map((ws) => ({
          slug: ws.slug,
          isActive: ws.slug === activeSlug,
        })),
      });
      return true;
    }

    if (
      req.method === "POST" &&
      pathname === "/api/dashboard/workspaces/switch"
    ) {
      const resolved = await gate(req, res);
      if (!resolved) return true;
      const body = (await readJsonBody(req).catch(() => ({}))) as {
        slug?: string;
      };
      if (typeof body.slug !== "string" || body.slug.length === 0) {
        sendJson(res, 400, { error: "slug_required" });
        return true;
      }
      const ws = await findWorkspace(body.slug);
      if (!ws) {
        sendJson(res, 404, { error: "unknown_slug", slug: body.slug });
        return true;
      }
      // Rebind the dashboard session to the new workspace. Scopes +
      // tokenLabel are preserved (the user re-authed with the same
      // token, just retargeting their session).
      setDashboardSession(resolved.sessionId, {
        workspace: ws.slug,
        scopes: resolved.session.dashboardScopes ?? ["admin"],
        tokenLabel: resolved.session.dashboardTokenLabel ?? "unknown",
      });
      sendJson(res, 200, { ok: true, workspace: ws.slug });
      return true;
    }

    if (
      req.method === "POST" &&
      pathname === "/api/dashboard/workspaces/create"
    ) {
      const resolved = await gate(req, res);
      if (!resolved) return true;
      const body = (await readJsonBody(req).catch(() => ({}))) as {
        slug?: string;
        fromPath?: string;
      };
      if (typeof body.slug !== "string" || body.slug.length === 0) {
        sendJson(res, 400, { error: "slug_required" });
        return true;
      }
      const slugCheck = validateSlug(body.slug);
      if (!slugCheck.ok) {
        sendJson(res, 400, { error: "invalid_slug", message: slugCheck.reason });
        return true;
      }
      const existing = await findWorkspace(body.slug);
      if (existing) {
        sendJson(res, 409, { error: "already_exists", slug: body.slug });
        return true;
      }
      try {
        const ws = await createWorkspace({
          slug: body.slug,
          ...(body.fromPath ? { fromPath: body.fromPath } : {}),
        });
        sendJson(res, 201, {
          ok: true,
          workspace: { slug: ws.slug, path: ws.path },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // createWorkspace throws on existing slugs too — catch the
        // race in case it slipped past the prior `findWorkspace`.
        if (message.includes("already exists")) {
          sendJson(res, 409, { error: "already_exists", slug: body.slug });
          return true;
        }
        ctx.logger.warn("dashboard.workspaces.create_failed", {
          slug: body.slug,
          error: message,
        });
        sendJson(res, 500, { error: "create_failed", message });
      }
      return true;
    }

    sendJson(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    ctx.logger.warn("dashboard.workspaces.unhandled", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: "internal",
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
