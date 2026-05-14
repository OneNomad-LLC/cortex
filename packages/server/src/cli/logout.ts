import { clearCredentials, getCredentialsPath } from "./credentials.js";

/**
 * `cortex logout` — wipe stored credentials. After this, `cortex
 * serve` falls back to local mode (or env-var overrides). Does not
 * destroy the remote Cortex Cloud deployment.
 */
export async function runLogout(_args: string[]): Promise<number> {
  const removed = await clearCredentials();
  if (!removed) {
    process.stdout.write(
      `cortex logout: no credentials at ${getCredentialsPath()} — already signed out.\n`,
    );
    return 0;
  }
  process.stdout.write(`cortex logout: signed out. Credentials cleared.\n`);
  return 0;
}
