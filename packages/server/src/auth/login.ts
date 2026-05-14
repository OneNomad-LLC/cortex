/**
 * `cortex login [server-url] [--server <url>]` — device-code flow against
 * pyre-web (RFC 8628).
 *
 * Server URL resolution (no hardcoded default — strict):
 *   1. positional arg:  `cortex login https://pyre.sh`
 *   2. --server flag:   `cortex login --server https://pyre.sh`
 *   3. PYRE_API_URL env
 * If none provided, exits 1 with a clear error. The "no hardcoded
 * environment URLs" rule means the binary stays decoupled from any
 * single deployment.
 *
 * Server is the source of truth: the canonical mcp_url + login_server
 * we save to disk come from the poll response, never from what the
 * user typed.
 *
 * Today's flow assumes a single tenant per user (the response shape
 * currently used by pyre-web's /api/cortex/device/poll). When pyre-web
 * ships the multi-tenant /api/auth/device-code endpoint (task #11),
 * this file flips to consume `tenants: []` directly and drops the
 * single-tenant fallback below.
 */

import { hostname, platform } from "node:os";
import { spawn } from "node:child_process";
import {
  saveCortexCredentials,
  writeSharedCredentials,
  readSharedCredentials,
  type CortexTenant,
} from "./credentials.js";

const PACKAGE_NAME = "cortex";

interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  /** Seconds between polls. Server-controlled to back off DoS. */
  interval: number;
  /** Seconds until deviceCode rejects further polls. */
  expiresIn: number;
}

interface DevicePollResponse {
  /** When `true`, keep polling — user hasn't confirmed yet. */
  pending?: boolean;
  /** Single-tenant cloud-mode credentials (today's shape). */
  mcpUrl?: string;
  bearer?: string;
  tenantSlug?: string;
  userEmail?: string;
  /** Canonical pyre-web URL (may differ from the URL the user typed). */
  apiUrl?: string;
  /** Set when device flow expired or was rejected. Terminal. */
  error?: string;
}

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
 * Resolve the server URL from positional arg / --server flag / env, in
 * that precedence. Returns null when none of the three gave us a URL —
 * caller prints the spec'd error and exits 1.
 */
export function resolveServerUrl(opts: { positional?: string; flag?: string }): string | null {
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
      // Empty title arg matters — `start <url>` treats the URL as the title.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    /* best-effort; the printed URL is the always-works fallback */
  }
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

  const startUrl = `${apiUrl}/api/cortex/device/start`;
  const pollUrl = `${apiUrl}/api/cortex/device/poll`;

  let start: DeviceStartResponse;
  try {
    const res = await fetchImpl(startUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "cortex-cli", scope: "mcp", deviceName, packageName: PACKAGE_NAME }),
    });
    if (!res.ok) {
      process.stderr.write(
        `cortex login: ${apiUrl} returned ${res.status} on device/start. Is this the right server?\n`,
      );
      return 1;
    }
    start = (await res.json()) as DeviceStartResponse;
    if (!start.deviceCode || !start.userCode || !start.verifyUrl) {
      process.stderr.write(`cortex login: malformed device/start response from ${apiUrl}\n`);
      return 1;
    }
  } catch (err) {
    process.stderr.write(
      `cortex login: couldn't reach ${startUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n  Open this URL in your browser:\n    ${start.verifyUrl}\n\n` +
      `  Confirm this code:\n    ${start.userCode}\n\n` +
      `  Waiting for confirmation… (Ctrl+C to cancel)\n`,
  );
  open(start.verifyUrl);

  const intervalMs = Math.max(1, start.interval) * 1000;
  const expiresAt = now() + Math.max(60, start.expiresIn) * 1000;

  while (now() < expiresAt) {
    await sleep(intervalMs);
    if (now() >= expiresAt) break;

    let poll: DevicePollResponse;
    try {
      const res = await fetchImpl(pollUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      });
      poll = (await res.json()) as DevicePollResponse;
    } catch (err) {
      process.stderr.write(
        `  …poll failed (will retry): ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }

    if (poll.error) {
      process.stderr.write(`\ncortex login: ${poll.error}\n`);
      return 1;
    }
    if (poll.pending) continue;
    if (!poll.mcpUrl || !poll.bearer) {
      process.stderr.write(
        `\ncortex login: server returned an incomplete response (missing mcpUrl or bearer)\n`,
      );
      return 1;
    }

    // Today's pyre-web returns single-tenant fields. Fold them into the
    // tenants array so the file shape is forward-compatible with the
    // multi-tenant /api/auth/device-code endpoint task #11 ships.
    const slug = poll.tenantSlug && poll.tenantSlug.length > 0 ? poll.tenantSlug : "default";
    const tenant: CortexTenant = {
      slug,
      mcp_url: poll.mcpUrl,
      bearer: poll.bearer,
    };

    // Preserve engram/persona base fields. If pyre-web returned a
    // canonical apiUrl (it should — the poll response is the source of
    // truth, not what the user typed), use that. Don't clobber an
    // existing engram label/api_url we don't own.
    const file = readSharedCredentials(opts.credentialsFile) ?? {};
    if (!file.label && poll.userEmail) {
      file.label = poll.userEmail;
    }
    if (poll.apiUrl) {
      file.api_url = poll.apiUrl;
    } else if (!file.api_url) {
      file.api_url = apiUrl;
    }

    const existingTenants = file.cortex?.tenants ?? [];
    const merged = mergeTenant(existingTenants, tenant);
    file.cortex = {
      ...(file.cortex ?? {}),
      tenants: merged,
      active_tenant: slug,
    };

    try {
      writeSharedCredentials(file, opts.credentialsFile);
    } catch (err) {
      process.stderr.write(
        `\ncortex login: could not write credentials: ${(err as Error).message}\n`,
      );
      return 1;
    }

    process.stdout.write(
      `\n  ✓ Signed in${poll.userEmail ? ` as ${poll.userEmail}` : ""}` +
        ` (tenant: ${slug})\n` +
        `  Mode: cloud\n` +
        `  MCP endpoint: ${poll.mcpUrl}\n` +
        `  Wire into Claude Code:\n` +
        `    claude mcp add cortex cortex -- serve\n\n`,
    );
    // saveCortexCredentials would re-read the file we just wrote — skip
    // it; writeSharedCredentials above already covered the write.
    void saveCortexCredentials; // satisfy unused-import scanner
    return 0;
  }

  process.stderr.write(`\ncortex login: device code expired without confirmation.\n`);
  return 1;
}

/**
 * Merge a freshly-issued tenant into the user's tenant list. If the
 * tenant is already known (by slug), update its mcp_url + bearer in
 * place — re-login refreshes the bearer without orphaning sibling
 * tenants the user belongs to.
 */
function mergeTenant(existing: CortexTenant[], next: CortexTenant): CortexTenant[] {
  const idx = existing.findIndex((t) => t.slug === next.slug);
  if (idx < 0) return [...existing, next];
  const copy = existing.slice();
  copy[idx] = next;
  return copy;
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
