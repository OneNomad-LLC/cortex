import { clearCortexCredentials, getCredentialsPath } from "../auth/credentials.js";

/**
 * `cortex logout` — remove only cortex's section of the shared
 * credentials file. Engram and persona credentials in the same file are
 * preserved; this isn't "wipe pyre," it's "sign cortex out."
 *
 * After this, `cortex serve` falls back to local mode (or env-var
 * overrides). Does not destroy any remote Cortex Cloud deployment.
 */
export async function runLogout(_args: string[]): Promise<number> {
  const removed = clearCortexCredentials();
  if (!removed) {
    process.stdout.write(
      `cortex logout: no cortex credentials at ${getCredentialsPath()} — already signed out.\n`,
    );
    return 0;
  }
  process.stdout.write(`cortex logout: signed out of cortex. Engram/persona credentials preserved.\n`);
  return 0;
}
