/**
 * `/api/dashboard/projects[...]` — server-side bridge to przm-access admin
 * API for project management.
 *
 * Surface:
 *   GET  /api/dashboard/projects            → { projects: ProjectRow[] }
 *   POST /api/dashboard/projects            body { slug, name }
 *
 * Reads same PRZM_ACCESS_* env vars as dashboard-members.ts.
 * Auth: admin scope.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, readJsonBody } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { getActiveWorkspace, findWorkspace } from "../../cli/workspace/manager.js";
import { parseDotEnv } from "../../cli/dotenv.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AccessConfig {
  adminUrl: string;
  operatorKey: string;
  tenantId: string;
}

async function resolveAccessConfig(
  sessionWorkspace: string | null | undefined,
): Promise<AccessConfig | null> {
  const ws = sessionWorkspace
    ? await findWorkspace(sessionWorkspace)
    : await getActiveWorkspace();
  if (!ws) return null;
  const env = parseDotEnv(ws.envPath);
  const adminUrl = (env.get("PRZM_ACCESS_ADMIN_URL") ?? "").replace(/\/$/, "");
  const operatorKey = env.get("PRZM_ACCESS_OPERATOR_KEY") ?? "";
  const tenantId = env.get("PRZM_ACCESS_TENANT_ID") ?? "";
  if (!adminUrl || !operatorKey || !tenantId) return null;
  return { adminUrl, operatorKey, tenantId };
}

async function proxyAccess(
  res: ServerResponse,
  cfg: AccessConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<boolean> {
  const url = `${cfg.adminUrl}/admin${path}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.operatorKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    sendJson(res, 502, {
      error: "access_unreachable",
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  let parsed: unknown;
  if (contentType.includes("application/json")) {
    try {
      parsed = await upstream.json();
    } catch {
      parsed = undefined;
    }
  } else {
    parsed = { raw: await upstream.text().catch(() => "") };
  }

  sendJson(res, upstream.status, parsed ?? { error: "empty_response" });
  return true;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;

  if (
    pathname !== "/api/dashboard/projects" &&
    !pathname.startsWith("/api/dashboard/projects/")
  ) {
    return false;
  }

  const gate = requireDashboardAuth(["admin"]);
  const session = await gate(req, res);
  if (!session) return true;

  const cfg = await resolveAccessConfig(session.session.workspace);
  if (!cfg) {
    sendJson(res, 400, {
      error: "access_not_configured",
      message:
        "Set PRZM_ACCESS_ADMIN_URL, PRZM_ACCESS_OPERATOR_KEY, and PRZM_ACCESS_TENANT_ID in the workspace .env.",
    });
    return true;
  }

  // GET /api/dashboard/projects
  if (req.method === "GET" && pathname === "/api/dashboard/projects") {
    return proxyAccess(res, cfg, "GET", `/tenants/${cfg.tenantId}/projects`);
  }

  // POST /api/dashboard/projects
  if (req.method === "POST" && pathname === "/api/dashboard/projects") {
    let body: Record<string, unknown>;
    try {
      body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid_body" });
      return true;
    }
    return proxyAccess(res, cfg, "POST", `/tenants/${cfg.tenantId}/projects`, {
      slug: body.slug,
      name: body.name,
    });
  }

  sendJson(res, 404, { error: "not_found" });
  return true;
}

export type { ProjectRow };
