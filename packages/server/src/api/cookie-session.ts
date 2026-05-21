import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Cookie-handoff session for the Cortex Cloud control surface.
 *
 * Flow:
 *   1. User clicks "Open Cortex" in pyre-web.
 *   2. Pyre-web mints a short-lived signed token (HMAC-SHA256 with the
 *      per-deployment gateway secret) carrying { sub: userId,
 *      tenant: tenantId, exp: now+5min }.
 *   3. Pyre-web links to `https://<cortex.fly.dev>/cortex-session/issue?token=<jwt>`.
 *   4. This module's `handleIssue` verifies the token, sets a
 *      `__Host-cortex-session` cookie (Secure, HttpOnly, SameSite=Strict)
 *      with a longer expiry (e.g. 24h), then 302s to `/`.
 *   5. Subsequent requests carry the cookie. `verifyCookie()` checks
 *      the signature against the gateway secret and accepts or rejects.
 *
 * The cookie value is itself a signed token (same HMAC, longer expiry)
 * so the server doesn't need session storage. Stateless.
 *
 * Why not a full JWT lib: this is a single-key HMAC use case in
 * a single trust boundary. Pulling jose / jsonwebtoken in adds 100KB
 * for one function. The Node `crypto` builtins do it in ~40 lines.
 *
 * Signing key resolution: `process.env.PRZM_CORTEX_GATEWAY_SECRET`. Must be
 * present for the cookie session to be enabled.
 */

const COOKIE_NAME = "__Host-cortex-session";
const ISSUE_TOKEN_TTL_SEC = 5 * 60; // 5 minutes — issue tokens are short-lived
const SESSION_COOKIE_TTL_SEC = 24 * 60 * 60; // 24h — cookie lifetime

export interface SessionClaims {
  /** User id (numeric). Source: pyre-web's Users collection. */
  sub: number;
  /** Tenant id (numeric). Source: pyre-web's Tenants collection. */
  tenant: number;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * Sign a claims payload with HMAC-SHA256. Output is the compact form
 * `<base64url(payload)>.<base64url(signature)>` — JWT-ish but without
 * a header (single algorithm, no negotiation, no `alg: none` risk).
 */
export function signToken(claims: SessionClaims, key: string): string {
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = createHmac("sha256", key).update(payload).digest();
  return `${payload}.${base64UrlEncode(sig)}`;
}

/**
 * Verify a compact token. Returns the claims on success, `null`
 * otherwise (bad signature, malformed, expired). Constant-time on the
 * signature check.
 */
export type VerifyFailureReason =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "bad-payload";

export interface VerifyResult {
  ok: boolean;
  claims?: SessionClaims;
  reason?: VerifyFailureReason;
}

/**
 * Detailed verify — surfaces *why* a token failed so the issuer can
 * log it. The plain `verifyToken` wrapper preserves the original
 * "claims or null" contract for existing callers (cookie path).
 */
export function verifyTokenDetailed(token: string, key: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;
  if (!payload || !sig) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", key).update(payload).digest();
  let supplied: Buffer;
  try {
    supplied = base64UrlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (supplied.length !== expected.length) {
    return { ok: false, reason: "bad-signature" };
  }
  if (!timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let claims: SessionClaims;
  try {
    const decoded = base64UrlDecode(payload).toString("utf8");
    claims = JSON.parse(decoded) as SessionClaims;
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.sub !== "number" || typeof claims.tenant !== "number") {
    return { ok: false, reason: "bad-payload" };
  }
  return { ok: true, claims };
}

export function verifyToken(token: string, key: string): SessionClaims | null {
  const result = verifyTokenDetailed(token, key);
  return result.ok && result.claims ? result.claims : null;
}

/**
 * Extract the session cookie from a request. Returns the verified
 * claims when valid, `null` otherwise. Reads the signing key from
 * `PRZM_CORTEX_GATEWAY_SECRET`; when that env var is unset, cookie session
 * is disabled and this returns `null` for every request (callers fall
 * back to bearer / gateway-secret gates).
 */
export function verifyCookie(req: IncomingMessage): SessionClaims | null {
  const key = process.env.PRZM_CORTEX_GATEWAY_SECRET;
  if (!key) return null;
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return null;
  const cookies = parseCookies(raw);
  const token = cookies.get(COOKIE_NAME);
  if (!token) return null;
  return verifyToken(token, key);
}

/**
 * `/cortex-session/issue?token=<issueToken>` handler. Verifies the
 * issue token, mints a longer-lived session cookie, redirects to `/`
 * (or to `?next=` when provided and same-origin).
 *
 * Returns true when handled, false when the path doesn't match — the
 * caller falls through to its own routing.
 */
export async function handleIssue(
  req: IncomingMessage,
  res: ServerResponse,
  logger?: { warn: (msg: string, extra?: Record<string, unknown>) => void },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/cortex-session/issue") return false;

  const key = process.env.PRZM_CORTEX_GATEWAY_SECRET;
  if (!key) {
    logger?.warn("cookie_session.issue.no_secret", {});
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("cookie session is not enabled on this deployment");
    return true;
  }

  const issueToken = url.searchParams.get("token");
  if (!issueToken) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("missing token");
    return true;
  }

  const result = verifyTokenDetailed(issueToken, key);
  if (!result.ok || !result.claims) {
    // Surface the failure reason in logs so operators don't have to
    // guess between "secret mismatch" / "expired token" / "mangled in
    // transit" when debugging the handoff. Token prefix is logged
    // (first 12 chars) so the same minted-and-verified token can be
    // correlated across pyre-web → Cortex without leaking the full
    // signature.
    logger?.warn("cookie_session.issue.rejected", {
      reason: result.reason ?? "unknown",
      tokenPrefix: issueToken.slice(0, 12),
      keyFingerprint: createHmac("sha256", key).update("").digest("hex").slice(0, 8),
    });
    res.statusCode = 401;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`invalid or expired token (${result.reason ?? "unknown"})`);
    return true;
  }

  const claims = result.claims;

  // Mint the session-cookie token (longer expiry, same shape).
  const now = Math.floor(Date.now() / 1000);
  const sessionToken = signToken(
    {
      sub: claims.sub,
      tenant: claims.tenant,
      iat: now,
      exp: now + SESSION_COOKIE_TTL_SEC,
    },
    key,
  );

  // `__Host-` prefix mandates Path=/, no Domain attribute, and Secure.
  // SameSite=Strict prevents the cookie from riding cross-site
  // requests — even the issue redirect from pyre-web works because
  // setting the cookie is a same-host action (the redirect target is
  // the same host the response lands at).
  const cookie = [
    `${COOKIE_NAME}=${sessionToken}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_COOKIE_TTL_SEC}`,
  ].join("; ");

  // `?next=/some/path` (relative only) controls where we land after
  // the cookie is set. Default to `/`.
  const next = url.searchParams.get("next");
  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

  res.statusCode = 302;
  res.setHeader("set-cookie", cookie);
  res.setHeader("location", safeNext);
  res.end();
  return true;
}

/** TTL on issue tokens — used by pyre-web's link minter. */
export { ISSUE_TOKEN_TTL_SEC, SESSION_COOKIE_TTL_SEC, COOKIE_NAME };

function parseCookies(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}
