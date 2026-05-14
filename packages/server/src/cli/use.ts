import {
  getCredentialsPath,
  loadCredentials,
  saveCredentials,
} from "./credentials.js";

/**
 * `cortex use <local|cloud>` — flip the mode flag. The actual
 * behavior change happens in `cortex serve`, which reads the mode at
 * spawn time. Useful when the user wants to A/B between a local
 * Cortex (development) and the cloud one (production) without
 * re-running `cortex login`.
 *
 * Switching to cloud without prior login is rejected so the user
 * doesn't end up with `serve` failing silently — the suggested fix is
 * printed verbatim.
 */
export async function runUse(args: string[]): Promise<number> {
  const target = args[0];
  if (target !== "local" && target !== "cloud") {
    process.stderr.write(
      `cortex use: target must be 'local' or 'cloud' (got '${target ?? ""}')\n`,
    );
    return 2;
  }
  const current = await loadCredentials();
  if (target === "cloud" && !current.mcpUrl && !current.fromEnv) {
    process.stderr.write(
      `cortex use cloud: no cloud credentials configured.\n` +
        `Run \`cortex login\` first, or set CORTEX_MCP_URL + CORTEX_MCP_TOKEN.\n`,
    );
    return 1;
  }

  if (current.fromEnv) {
    process.stdout.write(
      `cortex use ${target}: env vars (CORTEX_MCP_URL + CORTEX_MCP_TOKEN) are set ` +
        `and take precedence over the credentials file. Mode flag on disk ` +
        `won't have any effect while those are present.\n`,
    );
  }
  await saveCredentials({
    mode: target,
    ...(current.mcpUrl ? { mcpUrl: current.mcpUrl } : {}),
    ...(current.bearer ? { bearer: current.bearer } : {}),
    ...(current.tenantSlug ? { tenantSlug: current.tenantSlug } : {}),
    ...(current.userEmail ? { userEmail: current.userEmail } : {}),
    ...(current.loginServer ? { loginServer: current.loginServer } : {}),
  });
  process.stdout.write(
    `cortex use: mode set to ${target} (${getCredentialsPath()})\n`,
  );
  return 0;
}
