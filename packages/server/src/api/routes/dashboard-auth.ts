/**
 * `/api/dashboard/auth/*` — sign-in, sign-out, whoami for the browser
 * dashboard. The login route is the only one in the entire
 * `/api/dashboard/*` namespace that runs BEFORE the `apiAuthOk` gate
 * in `server.ts`; everything else gates through `requireDashboardAuth`.
 *
 * Surface:
 *   POST /api/dashboard/auth/login   { token } → 200 { ok, workspace, scopes }
 *                                                + Set-Cookie cortex_dash_sid
 *   POST /api/dashboard/auth/logout                 → 200 { ok: true }
 *   GET  /api/dashboard/auth/whoami                 → 200 { workspace, scopes, tokenLabel }
 *
 * The login route enforces a simple per-IP rate limit (5 attempts per
 * 60s). Tracking is in-memory because this is a single-process node
 * server; a horizontal redeploy resets counters which is fine — the
 * limit exists to slow online brute-force, not to enforce a quota.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonBody, sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import {
  COOKIE_NAME,
  buildClearCookie,
  buildSessionCookie,
  evictDashboardSession,
  readCookie,
  requireDashboardAuth,
} from "../middleware/require-dashboard-auth.js";
import {
  findTokenHashes,
  verifyToken,
} from "../../auth/dashboard-token.js";
import { parseDotEnv } from "../../cli/dotenv.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import {
  getSessionState,
  setDashboardSession,
} from "../../session-context.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

interface RateBucket {
  windowStart: number;
  count: number;
}
const ipBuckets = new Map<string, RateBucket>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  const bucket = ipBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    ipBuckets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX;
}

/** Test seam — drops every bucket. Called by tests between cases. */
export function _resetRateLimit(): void {
  ipBuckets.clear();
}

const loginSchema = z.object({ token: z.string().min(1) });

/**
 * Public login handler. Designed to be invoked from server.ts BEFORE
 * the global `apiAuthOk` gate so it can issue a session without
 * needing a prior credential. Returns `true` when the URL matches.
 */
export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  logger?: { warn: (msg: string, extra?: Record<string, unknown>) => void },
): Promise<boolean> {
  if (req.method !== "POST") return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/dashboard/auth/login") return false;

  const ip = req.socket.remoteAddress ?? "unknown";
  if (!checkRate(ip)) {
    sendJson(res, 429, { error: "rate_limited" });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "invalid_body" });
    return true;
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "invalid_body" });
    return true;
  }

  const ws = await getActiveWorkspace();
  if (!ws) {
    logger?.warn("dashboard.login.no_workspace", { ip });
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }

  const env = parseDotEnv(ws.envPath);
  const hashes = findTokenHashes(env);
  for (const candidate of hashes) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await verifyToken(parsed.data.token, candidate.hash);
    if (!ok) continue;
    const sessionId = `dash_${randomUUID()}`;
    setDashboardSession(sessionId, {
      workspace: ws.slug,
      scopes: ["admin"],
      tokenLabel: candidate.label,
    });
    res.setHeader("set-cookie", buildSessionCookie(req, sessionId));
    sendJson(res, 200, {
      ok: true,
      workspace: ws.slug,
      scopes: ["admin"],
      tokenLabel: candidate.label,
    });
    return true;
  }

  logger?.warn("dashboard.login.bad_token", { ip });
  sendJson(res, 401, { error: "unauthorized" });
  return true;
}

/**
 * Logout + whoami live behind the standard auth gate so we get the
 * route-context plumbing for free. Login does NOT route through here
 * because the gate would reject an unauthenticated client before the
 * handler ever ran.
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/dashboard/auth/")) return false;

  const { pathname } = ctx;

  if (req.method === "POST" && pathname === "/api/dashboard/auth/logout") {
    return handleLogout(req, res);
  }

  if (req.method === "GET" && pathname === "/api/dashboard/auth/whoami") {
    return handleWhoami(req, res);
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}

async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Logout is intentionally lenient on auth — a stale cookie that no
  // longer matches a session should still result in "cookie cleared",
  // not a 401. We still require the CSRF header to keep cross-site
  // forced-logout from being trivial.
  const csrf = req.headers["x-cortex-dashboard"];
  const csrfValue = Array.isArray(csrf) ? csrf[0] : csrf;
  if (typeof csrfValue !== "string" || csrfValue !== "1") {
    sendJson(res, 403, { error: "csrf_required" });
    return true;
  }

  const sid = readCookie(req, COOKIE_NAME);
  if (sid && sid.startsWith("dash_")) {
    evictDashboardSession(sid);
  }
  res.setHeader("set-cookie", buildClearCookie(req));
  sendJson(res, 200, { ok: true });
  return true;
}

async function handleWhoami(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const gate = requireDashboardAuth(["read"]);
  const resolved = await gate(req, res);
  if (!resolved) return true;
  // Belt-and-braces: re-read from sessionStates in case the gate
  // accepted a freshly-issued bearer session (its state is already
  // committed in the map, but pulling here keeps the return shape
  // consistent with cookie-path callers).
  const session = getSessionState(resolved.sessionId) ?? resolved.session;
  sendJson(res, 200, {
    workspace: session.workspace,
    scopes: session.dashboardScopes ?? [],
    tokenLabel: session.dashboardTokenLabel ?? null,
  });
  return true;
}
