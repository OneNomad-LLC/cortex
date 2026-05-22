/**
 * `/api/dashboard/auth/github/*` — GitHub OAuth Device Flow as the
 * primary dashboard sign-in. The token-paste path
 * (`/api/dashboard/auth/login`) stays for self-hosters who don't want
 * to point GitHub at their box; both routes mint the same kind of
 * `cortex_dash_sid` cookie + SessionState binding.
 *
 * Why device flow rather than web flow:
 *   - No client secret required — the OneNomad-published OAuth app
 *     ships with the binary, no per-self-hoster setup.
 *   - The browser polls our `/poll` endpoint while showing a spinner
 *     + the short user code. No callback handler, no CSRF window, no
 *     URL state to misroute.
 *   - Self-hosters who do want a web flow set
 *     `PRZM_CORTEX_GITHUB_OAUTH_CLIENT_ID` + `_SECRET` in their workspace
 *     env; the `/callback` stub returns 501 with that exact hint until
 *     the lead lands the secret-bearing flow.
 *
 * Allowlist gate: only users whose GitHub login appears in
 * `PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST` (comma-separated,
 * case-insensitive) can sign in. Default is empty → fail-closed. The
 * operator opens up the dashboard explicitly. Avoid burning a session
 * + cookie on a denied login: the device flow already authenticated
 * with GitHub, so we know who the user is — they just don't get past
 * our gate.
 *
 * Surface:
 *   POST /api/dashboard/auth/github/start                       → 200 { userCode, verificationUri, pollKey, intervalMs, expiresInMs }
 *   POST /api/dashboard/auth/github/poll   { pollKey }          → 200 { status, ... }
 *   GET  /api/dashboard/auth/github/callback?code=&state=       → 501 (stub)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJsonBody, sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import {
  buildSessionCookie,
} from "../middleware/require-dashboard-auth.js";
import { parseDotEnv } from "../../cli/dotenv.js";
import { mergeEnv } from "../../cli/config-mutation.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import {
  fetchGitHubUser,
  isAllowlisted,
  parseAllowlist,
  pollDeviceFlow,
  resolveClientId,
  startDeviceFlow,
} from "../../auth/github-oauth.js";
import { setGitHubSession } from "../../session-context.js";

/**
 * Decide whether the cortex API is bound to a "private" address that
 * makes auto-allowlist-first-user safe. Public bindings (0.0.0.0,
 * routable IPs) → unsafe; localhost / Tailscale CGNAT (100.64.0.0/10)
 * / private RFC1918 ranges (10/8, 172.16/12, 192.168/16) → safe.
 *
 * Operator can force the answer via PRZM_CORTEX_DASHBOARD_ALLOW_FIRST_USER_CLAIM:
 *   - "auto" (default): bind-based heuristic
 *   - "true": always claim (use when fronted by a TLS proxy you trust)
 *   - "false": never claim (production lockdown)
 */
function shouldAutoClaimFirstUser(
  envLookup: (name: string) => string | undefined,
): boolean {
  const override = envLookup("PRZM_CORTEX_DASHBOARD_ALLOW_FIRST_USER_CLAIM");
  if (override === "true") return true;
  if (override === "false") return false;
  // auto-mode: derive from the API bind address.
  const host = envLookup("PRZM_CORTEX_API_HOST") ?? "127.0.0.1";
  return isPrivateBindAddress(host);
}

function isPrivateBindAddress(host: string): boolean {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  // Tailscale CGNAT 100.64.0.0/10 (100.64.x.x – 100.127.x.x).
  const cgnat = host.match(/^100\.(\d+)\./);
  if (cgnat) {
    const n = Number(cgnat[1]);
    if (n >= 64 && n <= 127) return true;
  }
  // RFC1918 private ranges.
  if (host.startsWith("10.")) return true;
  if (host.startsWith("192.168.")) return true;
  const sixteen = host.match(/^172\.(\d+)\./);
  if (sixteen) {
    const n = Number(sixteen[1]);
    if (n >= 16 && n <= 31) return true;
  }
  // Anything else (0.0.0.0, public IPs) is treated as public.
  return false;
}

/** Active in-flight device-flow grants, keyed by an opaque poll key. */
interface PendingGrant {
  deviceCode: string;
  clientId: string;
  startedAt: number;
  /** Last poll attempt in epoch ms — used for the per-key rate limit. */
  lastPollAtMs: number;
}
const pendingGrants = new Map<string, PendingGrant>();

/** Hard expiry — GitHub device codes live 15 min; we drop our stash at 20. */
const GRANT_TTL_MS = 20 * 60 * 1000;

/** Per-IP poll rate-limit window — GitHub asks for ~5s; we go a bit faster. */
const POLL_RATE_LIMIT_MS = 2_000;
const POLL_BURST_LIMIT = 5;
interface PollBucket {
  windowStart: number;
  count: number;
}
const pollBuckets = new Map<string, PollBucket>();

/** Test seam — drop every in-flight grant + bucket. */
export function _resetPendingGrants(): void {
  pendingGrants.clear();
  pollBuckets.clear();
}

function reapExpired(now = Date.now()): void {
  for (const [key, grant] of pendingGrants) {
    if (now - grant.startedAt > GRANT_TTL_MS) {
      pendingGrants.delete(key);
    }
  }
}

function checkPollRate(ip: string): boolean {
  const now = Date.now();
  const bucket = pollBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= POLL_RATE_LIMIT_MS) {
    pollBuckets.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= POLL_BURST_LIMIT;
}

const pollSchema = z.object({ pollKey: z.string().min(1) });

/**
 * Test-deps surface. The route layer reads from real GitHub + the live
 * workspace by default; tests inject mocks via these knobs.
 */
export interface GitHubAuthDeps {
  fetchImpl?: typeof fetch;
  resolveWorkspace?: () => Promise<
    | {
        slug: string;
        envPath: string;
      }
    | undefined
  >;
  /** Override env lookup for the allowlist check — defaults to process.env. */
  envLookup?: (name: string) => string | undefined;
  /** Override the per-flow workspace env (allowlist + OAuth client id live here). */
  envParser?: (envPath: string) => ReadonlyMap<string, string>;
}

/**
 * Dispatcher for the github-auth namespace. Mirrors `dashboardAuthHandle`
 * so server.ts can just add this to the ROUTES array.
 */
export function buildHandle(deps: GitHubAuthDeps = {}) {
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RouteContext,
  ): Promise<boolean> {
    if (!ctx.pathname.startsWith("/api/dashboard/auth/github/")) return false;
    const { pathname } = ctx;

    try {
      if (req.method === "POST" && pathname === "/api/dashboard/auth/github/start") {
        return await handleStart(req, res, deps);
      }
      if (req.method === "POST" && pathname === "/api/dashboard/auth/github/poll") {
        return await handlePoll(req, res, deps);
      }
      if (req.method === "GET" && pathname === "/api/dashboard/auth/github/callback") {
        return handleCallback(res);
      }
      sendJson(res, 404, { error: "not found" });
      return true;
    } catch (err) {
      ctx.logger.warn("dashboard.github_oauth.failed", {
        method: req.method,
        path: pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, { error: "internal_error" });
      return true;
    }
  };
}

/** Default handler — bound to live deps. Registered in `server.ts`. */
export const handle = buildHandle();

async function resolveWorkspaceEnv(
  deps: GitHubAuthDeps,
): Promise<ReadonlyMap<string, string>> {
  const ws = await (deps.resolveWorkspace ?? getActiveWorkspace)();
  if (!ws) return new Map();
  const parser = deps.envParser ?? parseDotEnv;
  return parser(ws.envPath);
}

async function handleStart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: GitHubAuthDeps,
): Promise<boolean> {
  const wsEnv = await resolveWorkspaceEnv(deps);
  const { clientId } = resolveClientId(wsEnv);

  const grant = await startDeviceFlow(clientId, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const pollKey = randomUUID();
  reapExpired();
  pendingGrants.set(pollKey, {
    deviceCode: grant.deviceCode,
    clientId,
    startedAt: Date.now(),
    lastPollAtMs: 0,
  });
  // Hand intervals back in ms so the browser doesn't have to multiply.
  sendJson(res, 200, {
    userCode: grant.userCode,
    verificationUri: grant.verificationUri,
    pollKey,
    intervalMs: grant.interval * 1000,
    expiresInMs: grant.expiresIn * 1000,
  });
  return true;
}

async function handlePoll(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GitHubAuthDeps,
): Promise<boolean> {
  const ip = req.socket.remoteAddress ?? "unknown";
  if (!checkPollRate(ip)) {
    sendJson(res, 429, { status: "rate_limited" });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "invalid_body" });
    return true;
  }
  const parsed = pollSchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, { error: "invalid_body" });
    return true;
  }

  reapExpired();
  const grant = pendingGrants.get(parsed.data.pollKey);
  if (!grant) {
    sendJson(res, 410, {
      status: "expired",
      message: "poll key not found — start the flow again",
    });
    return true;
  }

  const result = await pollDeviceFlow(grant.clientId, grant.deviceCode, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // Transient states bubble straight back. The browser is responsible
  // for honoring slow_down by stretching its poll interval.
  if (result.status === "pending" || result.status === "slow_down") {
    grant.lastPollAtMs = Date.now();
    sendJson(res, 200, {
      status: result.status,
      ...(result.status === "slow_down"
        ? { hint: "back off polling; GitHub asked us to slow down" }
        : {}),
    });
    return true;
  }

  if (result.status === "expired" || result.status === "denied") {
    pendingGrants.delete(parsed.data.pollKey);
    sendJson(res, 200, { status: result.status });
    return true;
  }

  if (result.status === "error") {
    pendingGrants.delete(parsed.data.pollKey);
    sendJson(res, 502, {
      status: "error",
      message: result.errorDescription ?? "github oauth error",
    });
    return true;
  }

  // Authorized — finish the bind. Drop the stash either way so a
  // replay of the same pollKey doesn't issue a second session.
  pendingGrants.delete(parsed.data.pollKey);
  if (!result.accessToken) {
    sendJson(res, 502, { status: "error", message: "github returned no token" });
    return true;
  }

  const user = await fetchGitHubUser(result.accessToken, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const envLookup = deps.envLookup ?? ((name: string) => process.env[name]);
  const allowlist = parseAllowlist(
    envLookup("PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST"),
  );
  const ws = await (deps.resolveWorkspace ?? getActiveWorkspace)();

  // Empty allowlist on a privately-bound install → auto-claim the
  // first user as the workspace owner. Writes their GitHub login to
  // the workspace .env so subsequent logins flow normally.
  // On public bindings (0.0.0.0, routable IPs), bail with a helpful
  // error instead — otherwise a stranger on the internet could grab
  // the slot before the operator does.
  if (allowlist.size === 0) {
    if (ws && shouldAutoClaimFirstUser(envLookup)) {
      try {
        await mergeEnv(ws.envPath, {
          PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST: user.login,
        });
      } catch (err) {
        sendJson(res, 500, {
          status: "error",
          message:
            "failed to write allowlist on first-user claim — check workspace .env permissions",
        });
        return true;
      }
      // Fall through to the session-bind below. The next request from
      // anyone else will hit the normal allowlist check.
    } else {
      sendJson(res, 403, {
        status: "not_allowlisted",
        login: user.login,
        message:
          "PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST is empty and this cortex is bound to a public address. " +
          "SSH to the box and add your github login to the workspace .env, then retry.",
      });
      return true;
    }
  } else if (!isAllowlisted(allowlist, user.login)) {
    sendJson(res, 403, {
      status: "not_allowlisted",
      login: user.login,
      message:
        "this github user is not on the dashboard allowlist — ask the operator to add you to PRZM_CORTEX_DASHBOARD_GITHUB_ALLOWLIST",
    });
    return true;
  }

  const sessionId = `dash_${randomUUID()}`;
  setGitHubSession(sessionId, {
    workspace: ws?.slug ?? null,
    githubLogin: user.login,
    githubUserId: user.id,
    githubAvatarUrl: user.avatarUrl,
    githubAccessToken: result.accessToken,
    scopes: ["admin"],
  });
  res.setHeader("set-cookie", buildSessionCookie(req, sessionId));
  sendJson(res, 200, {
    status: "authorized",
    workspace: ws?.slug ?? null,
    scopes: ["admin"],
    login: user.login,
    avatarUrl: user.avatarUrl,
  });
  return true;
}

function handleCallback(res: ServerResponse): boolean {
  // Web-flow callback. Disabled until the lead lands the
  // secret-bearing flow — the device-flow path above is the canonical
  // sign-in. Surfacing a clear "here's how to turn it on" message
  // beats a 404.
  sendJson(res, 501, {
    error: "web_flow_disabled",
    message:
      "GitHub OAuth web flow is not enabled on this deployment. Use the Device Flow (POST /api/dashboard/auth/github/start). " +
      "To enable web flow, set PRZM_CORTEX_GITHUB_OAUTH_CLIENT_ID and PRZM_CORTEX_GITHUB_OAUTH_CLIENT_SECRET in your workspace env.",
  });
  return true;
}
