import { saveCredentials } from "./credentials.js";
import { openBrowser } from "./open-browser.js";

/**
 * `cortex login [--server <url>]` — device-code flow against pyre-web.
 *
 * Flow:
 *   1. POST {server}/api/cortex/device/start → { deviceCode, userCode,
 *      verifyUrl, interval, expiresIn }
 *   2. Print the userCode + open verifyUrl in the user's browser.
 *   3. Poll POST {server}/api/cortex/device/poll with { deviceCode }
 *      every `interval` seconds.
 *   4. On approval, pyre-web returns { mcpUrl, bearer, tenantSlug,
 *      userEmail }. Save to credentials.json + flip mode to "cloud".
 *
 * `--server` defaults to the public production server. Specify a
 * different one for staging/dev/self-hosted (we never bake env URLs
 * into source per the team's no-hardcoded-environment-urls rule, so
 * the default is itself overridable via CORTEX_LOGIN_SERVER).
 */

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
  /** Once confirmed, the cloud-mode credentials live here. */
  mcpUrl?: string;
  bearer?: string;
  tenantSlug?: string;
  userEmail?: string;
  /** Set when the device flow expired or was rejected. Terminal. */
  error?: string;
}

const DEFAULT_LOGIN_SERVER = "https://getpyre.ai";

export async function runLogin(args: string[]): Promise<number> {
  const server =
    parseFlag(args, "--server") ??
    process.env.CORTEX_LOGIN_SERVER ??
    DEFAULT_LOGIN_SERVER;
  const skipBrowser = args.includes("--no-browser");
  const startUrl = `${server.replace(/\/$/, "")}/api/cortex/device/start`;
  const pollUrl = `${server.replace(/\/$/, "")}/api/cortex/device/poll`;

  let start: DeviceStartResponse;
  try {
    const res = await fetch(startUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "cortex-cli", scope: "mcp" }),
    });
    if (!res.ok) {
      process.stderr.write(
        `cortex login: ${server} returned ${res.status} on device/start. ` +
          `Is this the right server?\n`,
      );
      return 1;
    }
    start = (await res.json()) as DeviceStartResponse;
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

  if (!skipBrowser) {
    void openBrowser(start.verifyUrl).catch(() => undefined);
  }

  const deadline = Date.now() + Math.max(60, start.expiresIn) * 1000;
  const intervalMs = Math.max(1, start.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let poll: DevicePollResponse;
    try {
      const res = await fetch(pollUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      });
      poll = (await res.json()) as DevicePollResponse;
    } catch (err) {
      // Transient network error — keep polling until the deadline.
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

    const filePath = await saveCredentials({
      mode: "cloud",
      mcpUrl: poll.mcpUrl,
      bearer: poll.bearer,
      ...(poll.tenantSlug ? { tenantSlug: poll.tenantSlug } : {}),
      ...(poll.userEmail ? { userEmail: poll.userEmail } : {}),
      loginServer: server,
    });
    process.stdout.write(
      `\n  ✓ Signed in${poll.userEmail ? ` as ${poll.userEmail}` : ""}` +
        `${poll.tenantSlug ? ` (${poll.tenantSlug})` : ""}\n` +
        `  Mode: cloud\n` +
        `  MCP endpoint: ${poll.mcpUrl}\n` +
        `  Credentials saved to: ${filePath}\n\n` +
        `  Wire into Claude Code:\n` +
        `    claude mcp add cortex cortex -- serve\n\n`,
    );
    return 0;
  }

  process.stderr.write(
    `\ncortex login: device code expired without confirmation.\n`,
  );
  return 1;
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx < 0) return undefined;
  const eq = args[idx]!.indexOf("=");
  if (eq >= 0) return args[idx]!.slice(eq + 1);
  return args[idx + 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
