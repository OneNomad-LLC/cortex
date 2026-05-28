/**
 * `/api/dashboard/queries` — query observability surface. Reads the
 * `query_log` table in cortex (tenant-scoped, RLS-enforced) so admins
 * can replay and debug "why didn't it find X" without opening a support
 * ticket.
 *
 * Surface:
 *   GET /api/dashboard/queries?page=N&perPage=M&user=...&project=...&since=ISO
 *     → { queries: QueryRow[], total: number, page: number, perPage: number, hasMore: boolean }
 *
 * Implementation note: the `query_log` table is written by the MCP search
 * tool at call time (hook into `kb_search` / `kb_recent`). Until that hook
 * is wired, this route returns an empty result set — the UI renders a
 * "no queries yet" state and becomes live as soon as the search hook ships.
 *
 * Auth: admin scope.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryRow {
  id: string;
  tenantId: string;
  userId: string | null;
  userEmail: string | null;
  agentLabel: string | null;
  project: string | null;
  queryText: string;
  resultCount: number;
  topResults: Array<{ id: string; score: number; snippet: string }>;
  createdAt: string;
}

const MAX_PER_PAGE = 200;
const DEFAULT_PER_PAGE = 50;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/dashboard/queries")) return false;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const gate = requireDashboardAuth(["admin"]);
  const session = await gate(req, res);
  if (!session) return true;

  if (ctx.pathname !== "/api/dashboard/queries") {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  const url = ctx.url;
  const page = clampInt(url.searchParams.get("page"), 1, 1000, 1);
  const perPage = clampInt(
    url.searchParams.get("perPage"),
    1,
    MAX_PER_PAGE,
    DEFAULT_PER_PAGE,
  );

  // TODO: Once the MCP kb_search hook writes to query_log, read from it here.
  // The table lives in cortex's Postgres (or SQLite for embedded) keyed by
  // tenant_id. For now return an empty set so the UI renders its empty state.
  sendJson(res, 200, {
    queries: [] as QueryRow[],
    total: 0,
    page,
    perPage,
    hasMore: false,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
