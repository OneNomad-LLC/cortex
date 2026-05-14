/**
 * `cortex login [server-url] [--server <url>]` — device-code flow against
 * pyre-web (RFC 8628), followed by a tenant-list fetch so one login
 * picks up every tenant the user belongs to.
 *
 * Server URL resolution (no hardcoded default — strict):
 *   1. positional arg:  `cortex login https://pyre.sh`
 *   2. --server flag:   `cortex login --server https://pyre.sh`
 *   3. PYRE_API_URL env
 * If none provided, exits 1 with a clear error. The "no hardcoded
 * environment URLs" rule means the binary stays decoupled from any
 * single deployment.
 *
 * Two-step flow:
 *
 *   1. Device-code: POST {api_url}/api/auth/device-code with
 *      `scopes: ["cortex:tenants", "cortex:invoke"]`. pyre-web mints a
 *      user-scoped session token (not a tenant-scoped api-key) and
 *      returns the bearer on first successful poll.
 *
 *   2. Tenant enumeration: GET {api_url}/api/cortex/tenants with that
 *      bearer. Returns every running Cortex deployment the user can
 *      reach via memberships[]. Pro users get one entry; enterprise
 *      users with multiple memberships get one per tenant.
 *
 * The user-token + canonical api_url go into the shared
 * ~/.pyre/credentials.json's base fields (matching engram/persona's
 * convention). The per-tenant mcp_url + bearer pairs go into the
 * cortex.tenants[] array there. active_tenant defaults to the first
 * tenant; use `cortex tenant switch <slug>` to change.
 *
 * Backward compat: nothing. The legacy /api/cortex/device/* endpoints
 * are deprecated. Users on old credentials keep working until their
 * bearer expires; re-running `cortex login` upgrades them.
 */

import { hostname, platform } from "node:os";
import { spawn } from "node:child_process";
import {
  writeSharedCredentials,
  readSharedCredentials,
  type CortexTenant,
} from "./credentials.js";

const PACKAGE_NAME = "cortex";
const SCOPES = ["cortex:tenants", "cortex:invoke"];

// ── pyre-web wire types ─────────────────────────────────────────────

interface DeviceCodeStart {
  user_code: string;
  device_code: string;
  api_url: string;
  verification_url: string;
  verification_url_complete?: string;
  expires_in: number;
  interval: number;
}

type DeviceCodePoll =
  | { status: "pending" }
  | {
      status: "approved";
      api_url: string;
      api_key: string;
      label: string;
      scopes: string[];
    }
  | { status: "denied" }
  | { status: "expired" };

interface TenantsResponse {
  user_email: string | null;
  tenants: Array<{
    slug: string;
    mcp_url: string;
    api_url: string;
    bearer: string;
    tenant_plan: string | null;
    role: string | null;
  }>;
}

// ── Public surface ──────────────────────────────────────────────────

export interface LoginOptions {
  /** pyre-web base URL — required. Caller resolves from arg/flag/env. */
  apiUrl: string;
  /** Override hostname (tests). */
  deviceName?: string;
  /** Override the writes-to-disk target (tests). */
  credentialsFile?: string;
  /** Override the "open in browser" hook (tests). */
  openBrowser?: (url: string) => void;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Override Date.now (tests). */
  now?: () => number;
}

/**
 * Resolve the server URL from positional arg / --server flag / env.
 * Returns null when none of the three gave us a URL.
 */
export function resolveServerUrl(opts: {
  positional?: string;
  flag?: string;
}): string | null {
  const trim = (s: string | undefined): string | null => {
    const t = s?.trim();
    if (!t) return null;
    return t.replace(/\/+$/, "");
  };
  return trim(opts.positional) ?? trim(opts.flag) ?? trim(process.env.PYRE_API_URL);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openInBrowser(url: string): void {
  try {
    const p = platform();
    if (p === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (p === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    /* best-effort; the printed URL is the always-works fallback */
  }
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: T }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }
  return { status: res.status, json: json as T };
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  bearer: string,
): Promise<{ status: number; json: T }> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }
  return { status: res.status, json: json as T };
}

/**
 * Run the login flow end-to-end. Returns 0 on success, non-zero on
 * failure. User-visible messages go to stdout (success) / stderr (errors).
 */
export async function runLoginFlow(opts: LoginOptions): Promise<number> {
  const apiUrl = opts.apiUrl.trim().replace(/\/+$/, "");
  const deviceName = opts.deviceName ?? hostname();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? sleepDefault;
  const now = opts.now ?? Date.now;
  const open = opts.openBrowser ?? openInBrowser;

  // Step 1 — start the device code.
  let start: DeviceCodeStart;
  try {
    const { status, json } = await postJson<DeviceCodeStart & { error?: string }>(
      fetchImpl,
      `${apiUrl}/api/auth/device-code`,
      {
        device_name: deviceName,
        package_name: PACKAGE_NAME,
        scopes: SCOPES,
      },
    );
    if (status < 200 || status >= 300) {
      process.stderr.write(
        `cortex login: ${apiUrl} returned ${status} on device-code start${
          json?.error ? `: ${json.error}` : ""
        }\n`,
      );
      return 1;
    }
    if (!json.user_code || !json.device_code || !json.verification_url) {
      process.stderr.write(`cortex login: malformed device-code response from ${apiUrl}\n`);
      return 1;
    }
    start = json;
  } catch (err) {
    process.stderr.write(
      `cortex login: couldn't reach ${apiUrl}/api/auth/device-code: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n  Open this URL in your browser:\n    ${start.verification_url}\n\n` +
      `  Confirm this code:\n    ${start.user_code}\n\n` +
      `  Waiting for confirmation… (Ctrl+C to cancel)\n`,
  );
  open(start.verification_url);

  // Step 2 — poll until approved/denied/expired.
  const intervalMs = Math.max(1, start.interval) * 1000;
  const expiresAt = now() + Math.max(60, start.expires_in) * 1000;
  let approved: Extract<DeviceCodePoll, { status: "approved" }> | null = null;

  while (now() < expiresAt) {
    await sleep(intervalMs);
    if (now() >= expiresAt) break;

    let pollRes: { status: number; json: DeviceCodePoll };
    try {
      pollRes = await postJson<DeviceCodePoll>(
        fetchImpl,
        `${start.api_url ?? apiUrl}/api/auth/device-code/poll`,
        { device_code: start.device_code },
      );
    } catch (err) {
      process.stderr.write(
        `  …poll failed (will retry): ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }

    // 410 carries `{ status: "expired" }`.
    if (pollRes.status === 410) {
      process.stderr.write(`\ncortex login: device code expired. Run \`cortex login\` again.\n`);
      return 1;
    }
    if (pollRes.status < 200 || pollRes.status >= 300) {
      process.stderr.write(
        `  …poll returned HTTP ${pollRes.status} (will retry)\n`,
      );
      continue;
    }

    const body = pollRes.json;
    switch (body.status) {
      case "pending":
        continue;
      case "denied":
        process.stderr.write(`\ncortex login: authorization denied.\n`);
        return 1;
      case "expired":
        process.stderr.write(`\ncortex login: device code expired.\n`);
        return 1;
      case "approved":
        approved = body;
        break;
    }
    if (approved) break;
  }

  if (!approved) {
    process.stderr.write(`\ncortex login: device code expired without confirmation.\n`);
    return 1;
  }

  // Step 3 — enumerate tenants with the new user-token.
  const canonicalApiUrl = approved.api_url.replace(/\/+$/, "");
  let tenantsResp: TenantsResponse;
  try {
    const { status, json } = await getJson<TenantsResponse & { error?: string }>(
      fetchImpl,
      `${canonicalApiUrl}/api/cortex/tenants`,
      approved.api_key,
    );
    if (status < 200 || status >= 300) {
      process.stderr.write(
        `cortex login: /api/cortex/tenants returned ${status}${
          json?.error ? `: ${json.error}` : ""
        }\n`,
      );
      return 1;
    }
    tenantsResp = json;
  } catch (err) {
    process.stderr.write(
      `cortex login: couldn't reach ${canonicalApiUrl}/api/cortex/tenants: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  // Step 4 — write everything to the shared credentials file.
  const file = readSharedCredentials(opts.credentialsFile) ?? {};
  if (tenantsResp.user_email && !file.label) {
    file.label = tenantsResp.user_email;
  }
  file.api_url = canonicalApiUrl;
  file.api_key = approved.api_key;
  if (approved.label && !file.label) file.label = approved.label;
  if (approved.scopes && approved.scopes.length > 0) {
    file.scopes = approved.scopes;
  }
  file.issued_at = new Date().toISOString();

  const tenants: CortexTenant[] = tenantsResp.tenants.map((t) => ({
    slug: t.slug,
    mcp_url: t.mcp_url,
    bearer: t.bearer,
  }));
  const activeTenant = tenants[0]?.slug;
  file.cortex = {
    ...(file.cortex ?? {}),
    tenants,
    ...(activeTenant ? { active_tenant: activeTenant } : {}),
  };

  try {
    writeSharedCredentials(file, opts.credentialsFile);
  } catch (err) {
    process.stderr.write(
      `\ncortex login: could not write credentials: ${(err as Error).message}\n`,
    );
    return 1;
  }

  // Step 5 — friendly success summary.
  if (tenants.length === 0) {
    process.stdout.write(
      `\n  ✓ Signed in${tenantsResp.user_email ? ` as ${tenantsResp.user_email}` : ""}\n` +
        `  No Cortex deployments are available for your account yet.\n` +
        `  Provision one from your dashboard: ${canonicalApiUrl}/dashboard/cortex\n\n`,
    );
    return 0;
  }

  if (tenants.length === 1) {
    const t = tenants[0]!;
    process.stdout.write(
      `\n  ✓ Signed in${tenantsResp.user_email ? ` as ${tenantsResp.user_email}` : ""}\n` +
        `  Tenant: ${t.slug}\n` +
        `  MCP endpoint: ${t.mcp_url}\n\n` +
        `  Wire into Claude Code:\n    claude mcp add cortex cortex -- serve\n\n`,
    );
    return 0;
  }

  process.stdout.write(
    `\n  ✓ Signed in${tenantsResp.user_email ? ` as ${tenantsResp.user_email}` : ""}\n` +
      `  ${tenants.length} tenants available; active = ${activeTenant}.\n` +
      `\n  Tenants:\n` +
      tenants
        .map((t) => `    ${t.slug === activeTenant ? "*" : " "} ${t.slug}  →  ${t.mcp_url}`)
        .join("\n") +
      `\n\n  Switch active tenant with:  cortex tenant switch <slug>\n\n` +
      `  Wire into Claude Code:\n    claude mcp add cortex cortex -- serve\n\n`,
  );
  return 0;
}

/**
 * CLI entry point — parses argv, resolves the server URL, runs the flow.
 * Kept thin so runLoginFlow stays unit-testable without a process.argv.
 */
export async function runLogin(args: string[]): Promise<number> {
  const positional = args.find((a) => !a.startsWith("--"));
  const flag = parseFlag(args, "--server");
  const apiUrl = resolveServerUrl({
    ...(positional ? { positional } : {}),
    ...(flag ? { flag } : {}),
  });
  if (!apiUrl) {
    process.stderr.write(
      `cortex login: server URL required.\n` +
        `Pass it as a positional arg, --server flag, or PYRE_API_URL env var:\n` +
        `  cortex login https://pyre.sh\n` +
        `  cortex login --server https://pyre.sh\n` +
        `  PYRE_API_URL=https://pyre.sh cortex login\n`,
    );
    return 1;
  }
  return runLoginFlow({ apiUrl });
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx < 0) return undefined;
  const eq = args[idx]!.indexOf("=");
  if (eq >= 0) return args[idx]!.slice(eq + 1);
  return args[idx + 1];
}
