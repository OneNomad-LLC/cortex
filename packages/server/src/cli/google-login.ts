import { input, password, checkbox, confirm } from "@inquirer/prompts";
import { runOAuthLoopback, defaultTokenPath, readGoogleToken } from "@cortex/google-auth";

/**
 * Interactive OAuth login for Google services. Writes a refresh token to
 * ~/.cortex/google-token.json (or CORTEX_GOOGLE_TOKEN_PATH) that
 * gmail / google-calendar / google-drive adapters read on startup.
 *
 * Run once per machine. If scopes change later (e.g. adding Drive after
 * a Gmail-only login), re-run this command and Google issues a new
 * refresh token with the expanded scope set.
 */

const SERVICE_SCOPES: Record<string, { label: string; scopes: readonly string[] }> = {
  gmail: {
    label: "Gmail (read-only)",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  },
  calendar: {
    label: "Google Calendar (read-only)",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  },
  drive: {
    label: "Google Drive (read-only)",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  },
};

export async function runGoogleLogin(_args: string[]): Promise<number> {
  process.stdout.write("\n=== Google OAuth login ===\n");
  process.stdout.write(
    "This walks you through granting Cortex a refresh token for the Google\n" +
      "APIs you pick. The token is written to ~/.cortex/google-token.json and\n" +
      "never leaves your machine.\n\n",
  );

  const tokenPath = defaultTokenPath();
  const existing = await tryReadToken(tokenPath);
  if (existing) {
    process.stdout.write(
      `Found an existing token at ${tokenPath}\n` +
        `  scopes: ${existing.scopes.join(", ") || "(none)"}\n`,
    );
    const overwrite = await confirm({
      message: "Overwrite it?",
      default: false,
    });
    if (!overwrite) {
      process.stdout.write("Keeping existing token. Nothing changed.\n");
      return 0;
    }
  }

  const services = await checkbox({
    message: "Which Google services should Cortex be able to read?",
    choices: Object.entries(SERVICE_SCOPES).map(([id, s]) => ({
      value: id,
      name: s.label,
    })),
    validate: (v) => (v.length > 0 ? true : "pick at least one"),
  });

  const scopes = services.flatMap((id) => SERVICE_SCOPES[id]!.scopes);

  process.stdout.write(
    "\nYou'll need an OAuth client from your Google Cloud project\n" +
      "(APIs & Services → Credentials → Create Credentials → OAuth client ID →\n" +
      "Desktop app). The client id + secret stay on your machine in the token file.\n\n",
  );

  const clientId = await input({
    message: "OAuth client ID",
    validate: (v) => (v.trim().length > 0 ? true : "required"),
  });
  const clientSecret = await password({
    message: "OAuth client secret",
    mask: "*",
  });

  process.stdout.write("\nOpening a loopback server and waiting for consent...\n");

  try {
    const token = await runOAuthLoopback({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes,
      onAuthUrl: (url) => {
        process.stdout.write(
          `\n  Open this URL in your browser and approve access:\n\n    ${url}\n\n` +
            "  Waiting for the redirect...\n",
        );
      },
    });
    process.stdout.write(
      `\nSuccess.\n  Token written to: ${tokenPath}\n  Granted scopes: ${token.scopes.join(", ")}\n\n` +
        "Next: run `cortex add gmail` / `cortex add google-calendar` / `cortex add google-drive`\n" +
        "to wire up the adapters.\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `\ngoogle-login failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function tryReadToken(tokenPath: string) {
  try {
    return await readGoogleToken(tokenPath);
  } catch {
    return undefined;
  }
}
