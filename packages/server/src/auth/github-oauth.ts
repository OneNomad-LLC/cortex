/**
 * GitHub OAuth Device Flow primitives for the dashboard sign-in path.
 *
 * Why a parallel module to `@onenomad/przm-cortex-github-auth`:
 *   That package serves the CLI's `cortex github-login` flow — it wraps
 *   start + poll into a single high-level call with its own retry loop.
 *   The dashboard needs lower-level handles: a `/start` HTTP route
 *   issues the device code, the browser polls `/poll` on its own
 *   schedule so the user can watch a spinner with progress, and the
 *   server returns a one-shot status on each poll rather than blocking.
 *   Sharing the wrapper would force the HTTP request to block until
 *   GitHub approves — not what the browser wants.
 *
 * These primitives are thin transport adapters; they don't store state.
 * The route layer (`dashboard-auth-github.ts`) holds the per-flow stash
 * in memory and decides allowlist + session-binding policy.
 *
 * Reference:
 *   https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

import { z } from "zod";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

/**
 * Placeholder Client ID. Production builds replace this string at
 * publish time with the real OneNomad-owned OAuth app id. Until the
 * lead swaps it in, `start()` will return a 502 from GitHub — which is
 * fine for tests that mock `fetch`. Search for this exact constant when
 * doing the pre-publish swap.
 *
 * The runtime resolution order is: `PRZM_CORTEX_GITHUB_OAUTH_CLIENT_ID`
 * from the workspace env (self-hosted operators bring their own OAuth
 * app) → `PRZM_CORTEX_DEFAULT_GITHUB_CLIENT_ID` from the process env
 * (build-time injection) → this placeholder. See `resolveClientId`.
 */
export const DEFAULT_ONENOMAD_CLIENT_ID =
  process.env.PRZM_CORTEX_DEFAULT_GITHUB_CLIENT_ID ??
  "Ov23li6ZlB9MbTVouCD9";

export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});

export interface DeviceFlowDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Open a device-flow grant. Returns the short user code (which the
 * browser displays so the user can type it into github.com/login/device)
 * plus the device code (held server-side and used during polling).
 */
export async function startDeviceFlow(
  clientId: string,
  deps: DeviceFlowDeps = {},
): Promise<DeviceFlowStart> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: clientId,
    // `repo` covers public + private repo metadata which the connector
    // catalog and ingest pipelines both need. `read:user` is required
    // so the allowlist check has a login + email to match against.
    scope: "repo read:user user:email",
  });
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `GitHub device-code request failed: ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
    );
  }
  const parsed = deviceCodeSchema.parse(await res.json());
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    expiresIn: parsed.expires_in,
    interval: parsed.interval,
  };
}

export type DeviceFlowPollStatus =
  | "pending"
  | "slow_down"
  | "authorized"
  | "expired"
  | "denied"
  | "error";

export interface DeviceFlowPollResult {
  status: DeviceFlowPollStatus;
  /** Present when `status === "authorized"`. */
  accessToken?: string;
  /** Space-separated scope string GitHub returned with the token. */
  scopes?: string[];
  /** Surfaced verbatim from GitHub for `error` status. */
  errorDescription?: string;
}

const tokenSuccessSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(""),
  token_type: z.string().default("bearer"),
});

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

/**
 * One-shot poll of the GitHub token endpoint. The caller decides
 * cadence — we hand back whichever terminal/transient state GitHub
 * reports without blocking. `slow_down` is mapped to its own status so
 * the route layer can lengthen its interval on the next call.
 */
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  deps: DeviceFlowDeps = {},
): Promise<DeviceFlowPollResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  // GitHub returns 200 even on error states (the JSON body carries the
  // status). Treat a non-200 with no JSON as a transport error.
  const json = (await res.json().catch(() => null)) as unknown;
  if (json == null) {
    return { status: "error", errorDescription: `transport ${res.status}` };
  }
  const success = tokenSuccessSchema.safeParse(json);
  if (success.success) {
    return {
      status: "authorized",
      accessToken: success.data.access_token,
      scopes: success.data.scope.split(/[\s,]+/).filter(Boolean),
    };
  }
  const err = tokenErrorSchema.safeParse(json);
  if (!err.success) {
    return {
      status: "error",
      errorDescription: `unexpected response: ${JSON.stringify(json).slice(0, 200)}`,
    };
  }
  switch (err.data.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      return {
        status: "error",
        ...(err.data.error_description !== undefined
          ? { errorDescription: err.data.error_description }
          : {}),
      };
  }
}

export interface GitHubUser {
  login: string;
  id: number;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

const githubUserSchema = z.object({
  login: z.string(),
  id: z.number(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
});

const githubEmailEntrySchema = z.object({
  email: z.string(),
  primary: z.boolean().optional(),
  verified: z.boolean().optional(),
});

/**
 * Resolve the authenticated GitHub user. Falls back to /user/emails for
 * the primary verified address when /user returns null (which it does
 * when the user has marked their email private). Email is best-effort —
 * the allowlist check below only requires `login`.
 */
export async function fetchGitHubUser(
  accessToken: string,
  deps: DeviceFlowDeps = {},
): Promise<GitHubUser> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const userRes = await fetchImpl(USER_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "przm-cortex",
    },
  });
  if (!userRes.ok) {
    const text = await userRes.text().catch(() => "");
    throw new Error(
      `GitHub /user request failed: ${userRes.status} ${userRes.statusText}: ${text.slice(0, 200)}`,
    );
  }
  const userJson = githubUserSchema.parse(await userRes.json());
  let email: string | null = userJson.email ?? null;

  if (!email) {
    // Best-effort second hop. Failures are non-fatal — we'll just keep
    // email=null.
    try {
      const emailsRes = await fetchImpl(EMAILS_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "przm-cortex",
        },
      });
      if (emailsRes.ok) {
        const rawList = (await emailsRes.json()) as unknown;
        if (Array.isArray(rawList)) {
          for (const entry of rawList) {
            const parsed = githubEmailEntrySchema.safeParse(entry);
            if (!parsed.success) continue;
            if (parsed.data.primary && parsed.data.verified) {
              email = parsed.data.email;
              break;
            }
          }
        }
      }
    } catch {
      // Swallow — email is optional for the allowlist check.
    }
  }

  return {
    login: userJson.login,
    id: userJson.id,
    email,
    name: userJson.name ?? null,
    avatarUrl: userJson.avatar_url ?? null,
  };
}

/**
 * Pick the OAuth Client ID for the active flow.
 *
 *   1. workspace env `PRZM_CORTEX_GITHUB_OAUTH_CLIENT_ID` — self-hosters
 *      who want to point Cortex at their own GitHub OAuth app override
 *      here. This is the only path that lets `/callback` web-flow
 *      eventually work (once a SECRET is also supplied).
 *   2. `DEFAULT_ONENOMAD_CLIENT_ID` — the OneNomad-published Cortex
 *      OAuth app id. Baked into the binary at publish time.
 *
 * Returns the resolved id and a tag describing which path was taken so
 * the route layer can log/troubleshoot.
 */
export function resolveClientId(workspaceEnv: ReadonlyMap<string, string>): {
  clientId: string;
  source: "workspace" | "default";
} {
  const fromEnv = workspaceEnv.get("PRZM_CORTEX_GITHUB_OAUTH_CLIENT_ID");
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { clientId: fromEnv, source: "workspace" };
  }
  return { clientId: DEFAULT_ONENOMAD_CLIENT_ID, source: "default" };
}

/**
 * Parse the comma-separated allowlist env var. Whitespace and case are
 * normalized — `Matt`, ` matt `, `MATT` all match. Empty / missing →
 * empty set (which means "nobody is allowlisted" and every login is
 * rejected with `not_allowlisted`; intentional fail-closed default).
 */
export function parseAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.length > 0) out.add(trimmed);
  }
  return out;
}

/** Case-insensitive membership check against a parsed allowlist. */
export function isAllowlisted(
  allowlist: ReadonlySet<string>,
  login: string,
): boolean {
  return allowlist.has(login.trim().toLowerCase());
}
