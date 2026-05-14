import { getCredentialsPath, loadCredentials } from "./credentials.js";

/**
 * `cortex whoami` — print the active credentials + mode. Useful for
 * confirming which Cortex an `MCP add` will hit, and for surfacing
 * env-var overrides so an operator running in CI knows the file isn't
 * the source of truth.
 *
 * Never prints the bearer. Surfaces the credentials path so the user
 * can `cat` it themselves when they need to debug.
 */
export async function runWhoami(_args: string[]): Promise<number> {
  const creds = await loadCredentials();
  if (creds.mode === "local") {
    process.stdout.write(
      `cortex whoami\n` +
        `  mode:        local\n` +
        `  endpoint:    in-process (cortex start / cortex serve)\n` +
        `  credentials: ${getCredentialsPath()} ${
          creds.userEmail ? "(present but unused in local mode)" : "(not present)"
        }\n` +
        `\nSwitch to cloud mode with:  cortex login\n`,
    );
    return 0;
  }

  const source = creds.fromEnv ? "env (CORTEX_MCP_URL + CORTEX_MCP_TOKEN)" : getCredentialsPath();
  process.stdout.write(
    `cortex whoami\n` +
      `  mode:        cloud${creds.fromEnv ? " (via env)" : ""}\n` +
      (creds.userEmail ? `  signed in:   ${creds.userEmail}\n` : "") +
      (creds.tenantSlug ? `  tenant:      ${creds.tenantSlug}\n` : "") +
      `  endpoint:    ${creds.mcpUrl ?? "(missing)"}\n` +
      `  bearer:      ${creds.bearer ? "*".repeat(8) + creds.bearer.slice(-4) : "(missing)"}\n` +
      (creds.loginServer ? `  signed in via: ${creds.loginServer}\n` : "") +
      `  credentials: ${source}\n` +
      (creds.updatedAt ? `  updated:     ${creds.updatedAt}\n` : "") +
      `\nSwitch to local mode with:  cortex use local\n`,
  );
  return 0;
}
