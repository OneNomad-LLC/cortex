import { confirm } from "@inquirer/prompts";
import {
  createDeviceFlow,
  defaultTokenPath,
  tryReadGithubToken,
  writeGithubToken,
} from "@onenomad/cortex-github-auth";
import { openBrowser } from "./detach.js";

/**
 * Client ID for the Cortex GitHub OAuth App. Device flow doesn't
 * require the secret — the user's consent at
 * github.com/login/device is what authorizes the token.
 *
 * Overridable via CORTEX_GITHUB_CLIENT_ID so operators forking Cortex
 * can register their own app without editing source.
 */
const DEFAULT_CLIENT_ID = "Ov23lidpaSywVEHtcXa4";

export async function runGithubLogin(args: readonly string[]): Promise<number> {
  const clientId = process.env.CORTEX_GITHUB_CLIENT_ID ?? DEFAULT_CLIENT_ID;
  const scopes = parseScopes(args) ?? ["repo"];

  const tokenPath = defaultTokenPath();
  const existing = await tryReadGithubToken(tokenPath);

  process.stdout.write("\n=== GitHub login ===\n");
  process.stdout.write(
    "Authorizes Cortex to read your repos via GitHub's device flow.\n" +
      `Token will be written to: ${tokenPath}\n\n`,
  );

  if (existing) {
    process.stdout.write(
      `Already signed in (scopes: ${existing.scopes.join(", ") || "(none)"}).\n`,
    );
    if (process.stdin.isTTY) {
      const overwrite = await confirm({
        message: "Run auth flow again and overwrite the existing token?",
        default: false,
      });
      if (!overwrite) {
        process.stdout.write("Keeping existing token.\n");
        return 0;
      }
    } else {
      process.stdout.write(
        "Non-TTY environment — skipping re-auth. Delete the token file to force a refresh.\n",
      );
      return 0;
    }
  }

  const flow = createDeviceFlow({ clientId, scopes });

  let grant;
  try {
    grant = await flow.start();
  } catch (err) {
    process.stderr.write(
      `Couldn't start device flow: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `\n  1. Open this URL: ${grant.verificationUri}\n` +
      `  2. Type this code: ${grant.userCode}\n` +
      `  3. Approve access to the Cortex app.\n\n` +
      `Cortex will detect approval automatically. Ctrl-C to abort.\n`,
  );

  // Best-effort browser open. Not fatal if it fails — the user can
  // click/paste the URL.
  void openBrowser(grant.verificationUri);

  let token;
  try {
    token = await flow.poll(grant);
  } catch (err) {
    process.stderr.write(
      `\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  await writeGithubToken(
    {
      accessToken: token.accessToken,
      scopes: token.scopes,
      clientId,
      grantedAt: new Date().toISOString(),
    },
    tokenPath,
  );
  process.stdout.write(
    `\nSuccess. Token saved to ${tokenPath}\n` +
      `Granted scopes: ${token.scopes.join(", ") || "(none — may need to re-run)"}\n\n` +
      "Next: run `cortex add github` to enable the adapter, then\n" +
      "`cortex sync github --dry-run --limit=5` to smoke-test.\n",
  );
  return 0;
}

function parseScopes(args: readonly string[]): string[] | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--scopes" || a === "-s") {
      const v = args[i + 1];
      if (!v) return undefined;
      return v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (a.startsWith("--scopes=")) {
      return a
        .slice("--scopes=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return undefined;
}
