/**
 * `/api/dashboard/members[...]` + `/api/dashboard/seats[...]` — server-side
 * bridge to the przm-access admin API. The operator key never reaches the
 * browser; the dashboard calls these routes and these routes fan-out to
 * przm-access with the right credentials.
 *
 * Surface:
 *   GET   /api/dashboard/members              → { members: MemberRow[] }
 *   POST  /api/dashboard/members              body { email, role, projects? }
 *   PATCH /api/dashboard/members/:userId      body { role }
 *   GET   /api/dashboard/seats                → { seatsUsed, seatCount, organizationId }
 *   PATCH /api/dashboard/seats/:userId        body { active: boolean }
 *
 * Env vars read from the active workspace's .env:
 *   PRZM_ACCESS_ADMIN_URL     — base URL of przm-access (e.g. https://access.przm.sh)
 *   PRZM_ACCESS_OPERATOR_KEY  — platform operator key
 *   PRZM_ACCESS_TENANT_ID     — tenant UUID for member / project ops
 *   PRZM_ACCESS_ORG_ID        — organization UUID for seat / audit ops
 *
 * Auth: admin scope. CSRF enforced on mutating methods via requireDashboardAuth.
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

interface AccessConfig {
  adminUrl: string;
  operatorKey: string;
  tenantId: string;
  orgId: string;
}

interface MemberRow {
  id: string;
  userId: string;
  tenantId: string;
  role: string;
  active: boolean;
  createdAt: string;
  user?: {
    id: string;
    email: string | null;
    name: string | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the przm-access config from the session's workspace .env. */
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
  const orgId = env.get("PRZM_ACCESS_ORG_ID") ?? "";
  if (!adminUrl || !operatorKey || !tenantId) return null;
  return { adminUrl, operatorKey, tenantId, orgId };
}

/**
 * Forward a request to przm-access admin API. Returns the parsed JSON
 * body (or throws if the upstream request fails at the network level).
 * Upstream 4xx/5xx are forwarded with their status code.
 */
async function proxyAccess(
  res: ServerResponse,
  cfg: AccessConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<boolean> {
  const url = `${cfg.adminUrl}/admin${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${cfg.operatorKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    sendJson(res, 502, {
      error: "access_unreachable",
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }

  if (upstream.status === 204) {
    res.writeHead(204);
    res.end();
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

  const isMembers =
    pathname === "/api/dashboard/members" ||
    pathname.startsWith("/api/dashboard/members/");
  const isSeats =
    pathname === "/api/dashboard/seats" ||
    pathname.startsWith("/api/dashboard/seats/");

  if (!isMembers && !isSeats) return false;

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

  // -------------------------------------------------------------------------
  // Members routes
  // -------------------------------------------------------------------------

  // GET /api/dashboard/members
  if (req.method === "GET" && pathname === "/api/dashboard/members") {
    return proxyAccess(res, cfg, "GET", `/tenants/${cfg.tenantId}/members`);
  }

  // POST /api/dashboard/members — add or invite by email
  if (req.method === "POST" && pathname === "/api/dashboard/members") {
    let body: Record<string, unknown>;
    try {
      body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid_body" });
      return true;
    }
    // Forward email + role; przm-access resolves or creates the user.
    return proxyAccess(res, cfg, "POST", `/tenants/${cfg.tenantId}/members`, {
      email: body.email,
      role: body.role,
    });
  }

  // PATCH /api/dashboard/members/:userId — set role
  const memberMatch = pathname.match(/^\/api\/dashboard\/members\/([^/]+)$/);
  if (req.method === "PATCH" && memberMatch) {
    const userId = decodeURIComponent(memberMatch[1]!);
    let body: Record<string, unknown>;
    try {
      body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid_body" });
      return true;
    }
    return proxyAccess(
      res,
      cfg,
      "PATCH",
      `/tenants/${cfg.tenantId}/members/${userId}`,
      { role: body.role },
    );
  }

  // -------------------------------------------------------------------------
  // Seats routes
  // -------------------------------------------------------------------------

  // GET /api/dashboard/seats
  if (req.method === "GET" && pathname === "/api/dashboard/seats") {
    if (!cfg.orgId) {
      sendJson(res, 400, {
        error: "access_not_configured",
        message: "Set PRZM_ACCESS_ORG_ID in the workspace .env for seat management.",
      });
      return true;
    }
    return proxyAccess(res, cfg, "GET", `/orgs/${cfg.orgId}/seats`);
  }

  // PATCH /api/dashboard/seats/:userId — toggle active
  const seatMatch = pathname.match(/^\/api\/dashboard\/seats\/([^/]+)$/);
  if (req.method === "PATCH" && seatMatch) {
    const userId = decodeURIComponent(seatMatch[1]!);
    if (!cfg.orgId) {
      sendJson(res, 400, {
        error: "access_not_configured",
        message: "Set PRZM_ACCESS_ORG_ID in the workspace .env for seat management.",
      });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "invalid_body" });
      return true;
    }
    return proxyAccess(
      res,
      cfg,
      "PATCH",
      `/orgs/${cfg.orgId}/seats/${userId}`,
      { active: body.active },
    );
  }

  sendJson(res, 404, { error: "not_found" });
  return true;
}

export type { MemberRow, AccessConfig };
