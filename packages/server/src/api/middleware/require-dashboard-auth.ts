/**
 * Dashboard auth gate.
 *
 * Wraps a route handler with the two-step auth check used by every
 * `/api/dashboard/*` endpoint except `/auth/login`:
 *
 *   1. Resolve a session: either an `Authorization: Bearer <token>`
 *      (verify against the active workspace's token hashes; on success
 *      mint a `dash_<uuid>` session) OR an existing `cortex_dash_sid`
 *      cookie (look up by id).
 *   2. Enforce CSRF + scope: every mutating method requires the
 *      `X-Cortex-Dashboard: 1` header; the resolved session's scopes
 *      must be a superset of `allowed`.
 *
 * The gate returns the resolved session on success or `null` after
 * writing a 401/403 response — handlers should early-return in both
 * cases. Bearer auth is intentionally accepted on every request, not
 * just login: pure-CLI clients (curl, agents) can hit the read API
 * without a cookie. The CSRF header still gates writes, so a
 * cross-site form post stays harmless.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { sendJson } from "../http.js";
import {
  findTokenHashes,
  verifyToken,
} from "../../auth/dashboard-token.js";
import { parseDotEnv } from "../../cli/dotenv.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import {
  evictDashboardSession,
  getSessionState,
  setDashboardSession,
  type SessionState,
} from "../../session-context.js";

export type DashboardScope = "read" | "ingest" | "admin";

const COOKIE_NAME = "cortex_dash_sid";
const COOKIE_TTL_SEC = 24 * 60 * 60; // 24h
const CSRF_HEADER = "x-cortex-dashboard";

export interface DashboardAuthSuccess {
  sessionId: string;
  session: SessionState;
}

export interface DashboardAuthDeps {
  /** Override workspace resolution — tests inject a fixed workspace. */
  resolveWorkspace?: () => Promise<{ slug: string; envPath: string } | undefined>;
}

/**
 * Resolve a session id + state without enforcing scope/CSRF. Used by
 * `/api/dashboard/auth/login` (which has its own response shape) and
 * indirectly by the public middleware factory below.
 *
 * On a successful bearer match, the function mints a fresh `dash_<uuid>`
 * id and records the session via `setDashboardSession`. The caller is
 * responsible for writing the `Set-Cookie` header — different routes
 * surface that differently (login returns JSON, the middleware sets it
 * on whatever response the handler writes).
 */
export async function resolveDashboardSession(
  req: IncomingMessage,
  deps: DashboardAuthDeps = {},
): Promise<DashboardAuthSuccess | null> {
  // 1. Bearer path — try first so a logged-out browser can still hit
  //    the API with `Authorization: Bearer <raw>` if it wants.
  const bearer = readBearer(req);
  if (bearer) {
    const ws = await (deps.resolveWorkspace ?? getActiveWorkspace)();
    if (!ws) return null;
    const env = parseDotEnv(ws.envPath);
    const hashes = findTokenHashes(env);
    for (const candidate of hashes) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await verifyToken(bearer, candidate.hash);
      if (!ok) continue;
      const sessionId = `dash_${randomUUID()}`;
      const session = setDashboardSession(sessionId, {
        workspace: ws.slug,
        scopes: ["admin"],
        tokenLabel: candidate.label,
      });
      return { sessionId, session };
    }
    return null;
  }

  // 2. Cookie path — look up the session id, require dashboardScopes.
  const cookieId = readCookie(req, COOKIE_NAME);
  if (!cookieId) return null;
  if (!cookieId.startsWith("dash_")) return null;
  const session = getSessionState(cookieId);
  if (!session || !session.dashboardScopes) return null;
  return { sessionId: cookieId, session };
}

/**
 * Render a Set-Cookie header value for the dashboard session id.
 *
 * `__Host-` prefix is intentionally avoided — the brief specifies
 * `cortex_dash_sid` as a plain name so the cookie also works on
 * the http://localhost dev path where Secure cannot be set. We do
 * stamp `Secure` whenever the request actually arrived over TLS.
 */
export function buildSessionCookie(req: IncomingMessage, sessionId: string): string {
  const parts = [
    `${COOKIE_NAME}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${COOKIE_TTL_SEC}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

/** Cookie value used to clear the session on logout. */
export function buildClearCookie(req: IncomingMessage): string {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Factory: build a gate keyed to a required scope set. Usage:
 *
 *   const gate = requireDashboardAuth(["admin"]);
 *   const ok = await gate(req, res);
 *   if (!ok) return;
 *
 * On a fresh bearer-issued session the gate also attaches the new
 * `Set-Cookie` to the response so the next request can ride the
 * cookie instead of re-presenting the bearer.
 */
export function requireDashboardAuth(
  allowed: ReadonlyArray<DashboardScope>,
  deps: DashboardAuthDeps = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<DashboardAuthSuccess | null> {
  return async (req, res) => {
    const resolved = await resolveDashboardSession(req, deps);
    if (!resolved) {
      sendJson(res, 401, { error: "unauthorized" });
      return null;
    }

    // Mutating methods require the CSRF header. This sits AFTER auth
    // so a missing-cookie write fails as 401 ("not logged in") rather
    // than 403 ("logged in but unsafe").
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const csrf = req.headers[CSRF_HEADER];
      const csrfValue = Array.isArray(csrf) ? csrf[0] : csrf;
      if (typeof csrfValue !== "string" || csrfValue !== "1") {
        sendJson(res, 403, { error: "csrf_required" });
        return null;
      }
    }

    const scopes = resolved.session.dashboardScopes ?? [];
    // "admin" is implicitly the union of read + ingest + admin. Without
    // this expansion, an admin-scoped session would fail
    // `requireDashboardAuth(["read"])` — which would be silly because
    // the admin scope is strictly more powerful than read.
    const effective = new Set<DashboardScope>(scopes);
    if (effective.has("admin")) {
      effective.add("read");
      effective.add("ingest");
    }
    const missing = allowed.filter((s) => !effective.has(s));
    if (missing.length > 0) {
      sendJson(res, 403, { error: "forbidden", required: allowed });
      return null;
    }

    // First-touch bearer auth: stamp the new cookie so subsequent
    // requests don't have to present the raw token again. Same shape
    // as the login route's Set-Cookie.
    if (readBearer(req) && !res.headersSent) {
      res.setHeader("set-cookie", buildSessionCookie(req, resolved.sessionId));
    }

    return resolved;
  };
}

function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(value);
  return m ? m[1]!.trim() : undefined;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

function isHttps(req: IncomingMessage): boolean {
  // X-Forwarded-Proto when behind a TLS-terminating proxy, or the
  // underlying socket when serving HTTPS directly. node:http's
  // IncomingMessage doesn't expose `protocol` on `req`; checking the
  // socket's encrypted bit catches the direct-TLS case.
  const xfp = req.headers["x-forwarded-proto"];
  const xfpValue = Array.isArray(xfp) ? xfp[0] : xfp;
  if (typeof xfpValue === "string" && xfpValue.toLowerCase() === "https") {
    return true;
  }
  // `encrypted` is set on TLSSocket but not on plain Socket. Defensive
  // optional-chaining keeps tests with synthetic sockets happy.
  const sock = req.socket as { encrypted?: boolean } | undefined;
  return sock?.encrypted === true;
}

export {
  COOKIE_NAME,
  COOKIE_TTL_SEC,
  CSRF_HEADER,
  evictDashboardSession,
  readBearer,
  readCookie,
};
