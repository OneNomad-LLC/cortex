import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * CLI-scope token. A compact HMAC-signed payload (same shape as
 * cookie-session tokens but with a different claim set) that the
 * cortex CLI gets at login and presents on every MCP request via the
 * Authorization: Bearer header.
 *
 * Different claim shape from the cookie session keeps domains
 * separate — a forged cookie can't be reused as a CLI bearer and
 * vice versa, because verifyScopeToken rejects anything missing the
 * `scopes` field.
 *
 * Signing key: shared with cookie-session — pyre-web's stored
 * `gatewaySecret` per deployment, Cortex's `PRZM_CORTEX_GATEWAY_SECRET`
 * env var. Single key per deployment keeps key management simple
 * for v1; per-key rotation lands with the dedicated cortex-api-keys
 * collection follow-up.
 */

export interface ScopeClaims {
  /** Subject — pyre-web user id (numeric). */
  sub: number;
  /** Tenant id. */
  tenant: number;
  /**
   * Bundle names the bearer is authorized for. Canonical: "read",
   * "ingest", "admin"; custom bundles (future enterprise RBAC) get
   * stamped here too under the same field. Cortex resolves to a
   * concrete tool set via expandScopes().
   */
  scopes: string[];
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

/** Sign + serialize a scope token. */
export function signScopeToken(claims: ScopeClaims, key: string): string {
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = createHmac("sha256", key).update(payload).digest();
  return `cscope.${payload}.${base64UrlEncode(sig)}`;
}

/**
 * Verify a scope token. Returns the claims on success, `null` on any
 * failure (bad signature, expired, missing scopes claim).
 *
 * Tokens not starting with the `cscope.` prefix are rejected
 * immediately — they're being presented as Bearer values, but the
 * legacy opaque bearer (PRZM_CORTEX_API_AUTH_TOKEN) doesn't carry the
 * prefix, so the prefix is the cheap discriminator that lets a
 * single Authorization header serve both paths.
 */
export function verifyScopeToken(
  token: string,
  key: string,
): ScopeClaims | null {
  if (!token.startsWith("cscope.")) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;
  if (!payload || !sig) return null;

  const expected = createHmac("sha256", key).update(payload).digest();
  let supplied: Buffer;
  try {
    supplied = base64UrlDecode(sig);
  } catch {
    return null;
  }
  if (supplied.length !== expected.length) return null;
  if (!timingSafeEqual(supplied, expected)) return null;

  let claims: ScopeClaims;
  try {
    const decoded = base64UrlDecode(payload).toString("utf8");
    claims = JSON.parse(decoded) as ScopeClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (typeof claims.sub !== "number" || typeof claims.tenant !== "number") {
    return null;
  }
  if (!Array.isArray(claims.scopes) || claims.scopes.some((s) => typeof s !== "string")) {
    return null;
  }
  return claims;
}

/**
 * Convenience: return the verified scope claims for a request's
 * Authorization header, or null when the header is missing /
 * malformed / opaque-bearer (i.e. NOT a cscope token). Callers use
 * this to figure out the tool surface; missing claims means "fall
 * back to full surface" (the legacy opaque-bearer path) so existing
 * scripts and the dashboard's gateway-secret access keep working.
 */
export function readScopeClaimsFromAuthHeader(
  authHeader: string | undefined,
  key: string | undefined,
): ScopeClaims | null {
  if (!authHeader || !key) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return null;
  return verifyScopeToken(match[1]!.trim(), key);
}
