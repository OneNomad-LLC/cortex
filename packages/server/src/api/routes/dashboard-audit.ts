/**
 * `/api/dashboard/audit` — read-only audit event feed for the dashboard.
 * Proxies to przm-access `GET /admin/orgs/:id/audit` server-side so the
 * operator key stays off the browser.
 *
 * Surface:
 *   GET /api/dashboard/audit?since=ISO&cursor=...&limit=N
 *     → { events: AuditEvent[], nextCursor: string | null }
 *
 * Reads PRZM_ACCESS_ADMIN_URL, PRZM_ACCESS_OPERATOR_KEY, PRZM_ACCESS_ORG_ID
 * from the active workspace .env.
 *
 * Auth: admin scope (owners/admins see all events; member-scoped filtering
 * is a future phase once the dashboard has a real membership Principal).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { getActiveWorkspace, findWorkspace } from "../../cli/workspace/manager.js";
import { parseDotEnv } from "../../cli/dotenv.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  organizationId: string;
  tenantId: string | null;
  userId: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuditConfig {
  adminUrl: string;
  operatorKey: string;
  orgId: string;
}

async function resolveAuditConfig(
  sessionWorkspace: string | null | undefined,
): Promise<AuditConfig | null> {
  const ws = sessionWorkspace
    ? await findWorkspace(sessionWorkspace)
    : await getActiveWorkspace();
  if (!ws) return null;
  const env = parseDotEnv(ws.envPath);
  const adminUrl = (env.get("PRZM_ACCESS_ADMIN_URL") ?? "").replace(/\/$/, "");
  const operatorKey = env.get("PRZM_ACCESS_OPERATOR_KEY") ?? "";
  const orgId = env.get("PRZM_ACCESS_ORG_ID") ?? "";
  if (!adminUrl || !operatorKey || !orgId) return null;
  return { adminUrl, operatorKey, orgId };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/dashboard/audit")) return false;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const gate = requireDashboardAuth(["admin"]);
  const session = await gate(req, res);
  if (!session) return true;

  if (ctx.pathname !== "/api/dashboard/audit") {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  const cfg = await resolveAuditConfig(session.session.workspace);
  if (!cfg) {
    sendJson(res, 400, {
      error: "access_not_configured",
      message:
        "Set PRZM_ACCESS_ADMIN_URL, PRZM_ACCESS_OPERATOR_KEY, and PRZM_ACCESS_ORG_ID in the workspace .env.",
    });
    return true;
  }

  // Forward query params to przm-access: since, cursor, limit.
  const params = new URLSearchParams();
  const since = ctx.url.searchParams.get("since");
  const cursor = ctx.url.searchParams.get("cursor");
  const limit = ctx.url.searchParams.get("limit");
  if (since) params.set("since", since);
  if (cursor) params.set("cursor", cursor);
  if (limit) params.set("limit", limit);

  const qs = params.toString();
  const url = `${cfg.adminUrl}/admin/orgs/${cfg.orgId}/audit${qs ? `?${qs}` : ""}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.operatorKey}`,
        Accept: "application/json",
      },
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
