/**
 * `cortex tenant <list|switch|refresh>` — manage the active tenant in
 * the shared credentials file when the user belongs to more than one.
 *
 *   list                       Show all tenants the user has access
 *                              to, with the active one starred.
 *   switch <slug>              Mark <slug> as the active tenant. No
 *                              network call — pure file edit.
 *   refresh                    Re-fetch /api/cortex/tenants from
 *                              pyre-web. Useful after the user is
 *                              added/removed from a tenant by an
 *                              admin without going through `cortex
 *                              login` again.
 */

import {
  getCredentialsPath,
  loadCortexCredentials,
  readSharedCredentials,
  saveCortexCredentials,
  writeSharedCredentials,
  type CortexTenant,
} from "../auth/credentials.js";

const SUBCOMMANDS = ["list", "switch", "refresh"] as const;

export async function runTenant(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || !SUBCOMMANDS.includes(sub as (typeof SUBCOMMANDS)[number])) {
    process.stderr.write(
      `cortex tenant: subcommand required (one of: ${SUBCOMMANDS.join(", ")})\n` +
        `  cortex tenant list\n` +
        `  cortex tenant switch <slug>\n` +
        `  cortex tenant refresh\n`,
    );
    return 2;
  }

  if (sub === "list") return runList();
  if (sub === "switch") return runSwitch(args.slice(1));
  if (sub === "refresh") return runRefresh();
  return 2;
}

function runList(): number {
  const creds = loadCortexCredentials();
  const file = readSharedCredentials();
  const tenants = file?.cortex?.tenants ?? [];
  const active = file?.cortex?.active_tenant;

  if (tenants.length === 0) {
    process.stdout.write(
      `cortex tenant list: no tenants on this machine.\n` +
        `  Run \`cortex login <pyre-web-url>\` to sign in.\n`,
    );
    return 0;
  }

  process.stdout.write(
    `cortex tenant list (${tenants.length} tenant${tenants.length === 1 ? "" : "s"})\n\n`,
  );
  const slugWidth = Math.max(...tenants.map((t) => t.slug.length), 8);
  for (const t of tenants) {
    const marker = t.slug === active ? "*" : " ";
    process.stdout.write(
      `  ${marker} ${t.slug.padEnd(slugWidth)}  ${t.mcp_url}\n`,
    );
  }
  process.stdout.write(
    `\n  ${creds.fromEnv ? "(env vars override the active tenant for serve)" : `active marker: *  ·  source: ${getCredentialsPath()}`}\n`,
  );
  return 0;
}

function runSwitch(args: string[]): number {
  const target = args[0];
  if (!target) {
    process.stderr.write(`cortex tenant switch: slug required.\n  cortex tenant switch <slug>\n`);
    return 2;
  }
  const file = readSharedCredentials();
  const tenants = file?.cortex?.tenants ?? [];
  const exists = tenants.find((t) => t.slug === target);
  if (!exists) {
    process.stderr.write(
      `cortex tenant switch: unknown tenant '${target}'.\n` +
        `  Available: ${tenants.map((t) => t.slug).join(", ") || "(none — run `cortex login` first)"}\n`,
    );
    return 1;
  }
  saveCortexCredentials({ active_tenant: target });
  process.stdout.write(
    `cortex tenant switch: active tenant is now '${target}'.\n  MCP endpoint: ${exists.mcp_url}\n`,
  );
  return 0;
}

/**
 * Re-fetch the tenant list from pyre-web. We re-use the api_url +
 * api_key already on the shared credentials file — the user-token is
 * what authorizes the tenant-list call, no re-login needed.
 *
 * In air-gap mode (PRZM_CORTEX_TELEMETRY=disabled) this command is
 * blocked: pyre-web is unreachable and the tenant list is managed
 * by the operator via the credentials file directly.
 */
async function runRefresh(): Promise<number> {
  if (process.env["PRZM_CORTEX_TELEMETRY"] === "disabled") {
    process.stderr.write(
      "cortex tenant refresh: PRZM_CORTEX_TELEMETRY=disabled — network calls to pyre-web are not permitted in air-gap mode.\n" +
        "  Manage tenants by editing the credentials file directly, or re-run with telemetry enabled.\n",
    );
    return 1;
  }

  const file = readSharedCredentials();
  if (!file?.api_url || !file?.api_key) {
    process.stderr.write(
      `cortex tenant refresh: no pyre-web session on this machine.\n` +
        `  Run \`cortex login <pyre-web-url>\` first.\n`,
    );
    return 1;
  }

  const url = `${file.api_url.replace(/\/+$/, "")}/api/cortex/tenants`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${file.api_key}` },
    });
  } catch (err) {
    process.stderr.write(
      `cortex tenant refresh: couldn't reach ${url}: ${(err as Error).message}\n`,
    );
    return 1;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    process.stderr.write(
      `cortex tenant refresh: ${url} returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}\n`,
    );
    if (res.status === 401) {
      process.stderr.write(`  Your user token may be expired — run \`cortex login\` again.\n`);
    }
    return 1;
  }

  const body = (await res.json().catch(() => ({}))) as {
    tenants?: Array<{ slug: string; mcp_url: string; bearer: string }>;
    user_email?: string | null;
  };
  const tenants: CortexTenant[] = (body.tenants ?? []).map((t) => ({
    slug: t.slug,
    mcp_url: t.mcp_url,
    bearer: t.bearer,
  }));

  const existing = readSharedCredentials() ?? {};
  const currentActive = existing.cortex?.active_tenant;
  // If the active tenant is still in the new list, keep it. Otherwise
  // fall back to the first (or undefined when the list is empty).
  const newActive =
    currentActive && tenants.some((t) => t.slug === currentActive)
      ? currentActive
      : tenants[0]?.slug;

  existing.cortex = {
    ...(existing.cortex ?? {}),
    tenants,
    ...(newActive ? { active_tenant: newActive } : {}),
  };
  // Clean up active_tenant if no tenants remain.
  if (!newActive && existing.cortex.active_tenant) {
    delete existing.cortex.active_tenant;
  }
  writeSharedCredentials(existing);

  process.stdout.write(
    `cortex tenant refresh: ${tenants.length} tenant${tenants.length === 1 ? "" : "s"}` +
      `${newActive ? ` (active: ${newActive})` : ""}.\n`,
  );
  return 0;
}
