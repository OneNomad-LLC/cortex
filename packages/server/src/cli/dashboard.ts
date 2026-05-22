/**
 * `cortex dashboard ...` — manage browser-session login tokens for the
 * Cortex dashboard.
 *
 * Tokens are how the dashboard's browser UI authenticates against the
 * HTTP API on `localhost:4141`. The operator runs
 *
 *   cortex dashboard create-token --label my-laptop
 *
 * which prints a 64-char hex string. Paste that into the dashboard
 * login page once; it sets an HttpOnly `cortex_dash_sid` cookie that
 * the browser keeps for 24h. We never store the raw token — only the
 * Argon2id hash, written to the active workspace's `.env` under
 * `PRZM_CORTEX_DASHBOARD_TOKEN_HASH_<LABEL>=...`.
 *
 * Commands:
 *   create-token [--label <name>] [--scopes admin]
 *   rotate-token <label>
 *   revoke-token <label>
 *   list-tokens
 *
 * No subcommand → help. The output reuses the same writer style as
 * other CLI modules (plain text to stdout, errors to stderr, exit code
 * matches the reasonable expectation: 0 success, 1 user error, 2 usage
 * error).
 */

import { getActiveWorkspace } from "./workspace/manager.js";
import { mergeEnv, removeEnvKeys } from "./config-mutation.js";
import { parseDotEnv } from "./dotenv.js";
import {
  DASHBOARD_TOKEN_HASH_PREFIX,
  envKeyForLabel,
  findTokenHashes,
  generateRawToken,
  hashToken,
  labelForEnvKey,
} from "../auth/dashboard-token.js";

const HELP = `cortex dashboard — manage dashboard browser-session tokens

Usage:
  cortex dashboard <command> [options]

Commands:
  create-token [--label <name>] [--scopes admin]
                              Generate a new raw token, store its hash
                              in the active workspace's .env, and print
                              the raw value ONCE.

  rotate-token <label>        Replace an existing label's hash with a
                              fresh raw token. Old token stops working.

  revoke-token <label>        Remove the hash for a label entirely.

  list-tokens                 Print labels currently authorized.

Notes:
  - Tokens are per-workspace. \`cortex workspace switch\` to manage a
    different one.
  - Labels are case-insensitive; "my browser" and "MY_BROWSER" map to
    the same env key (PRZM_CORTEX_DASHBOARD_TOKEN_HASH_MY_BROWSER).
  - The raw token is shown exactly once. Store it in your password
    manager immediately.
`;

export async function runDashboard(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    case "create-token":
      return runCreateToken(rest);
    case "rotate-token":
      return runRotateToken(rest);
    case "revoke-token":
      return runRevokeToken(rest);
    case "list-tokens":
      return runListTokens();
    default:
      process.stderr.write(
        `cortex dashboard: unknown subcommand '${sub}'\n\n${HELP}`,
      );
      return 2;
  }
}

interface CreateOpts {
  label: string;
  scopes: ReadonlyArray<"read" | "ingest" | "admin">;
}

function parseCreateArgs(args: string[]): CreateOpts | string {
  let label = "DEFAULT";
  const scopes: Array<"read" | "ingest" | "admin"> = ["admin"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--label") {
      const next = args[++i];
      if (!next) return "--label requires a value";
      label = next;
    } else if (arg === "--scopes") {
      const next = args[++i];
      if (!next) return "--scopes requires a value";
      // Currently only "admin" is honored — keep the flag in the
      // surface so future scope work doesn't break the CLI contract.
      const parts = next.split(",").map((s) => s.trim()).filter(Boolean);
      const valid = new Set(["read", "ingest", "admin"]);
      for (const p of parts) {
        if (!valid.has(p)) {
          return `unknown scope '${p}' (expected: read, ingest, admin)`;
        }
      }
      scopes.length = 0;
      for (const p of parts) {
        scopes.push(p as "read" | "ingest" | "admin");
      }
    } else {
      return `unexpected argument '${arg}'`;
    }
  }
  return { label, scopes };
}

async function runCreateToken(args: string[]): Promise<number> {
  const parsed = parseCreateArgs(args);
  if (typeof parsed === "string") {
    process.stderr.write(`cortex dashboard create-token: ${parsed}\n`);
    return 2;
  }

  const ws = await getActiveWorkspace();
  if (!ws) {
    process.stderr.write(
      "cortex dashboard create-token: no active workspace. Run `cortex workspace switch <slug>` or `cortex workspace add <slug>` first.\n",
    );
    return 1;
  }

  let envKey: string;
  try {
    envKey = envKeyForLabel(parsed.label);
  } catch (err) {
    process.stderr.write(
      `cortex dashboard create-token: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const existing = parseDotEnv(ws.envPath);
  if (existing.has(envKey)) {
    process.stderr.write(
      `cortex dashboard create-token: label '${parsed.label}' already exists. Use 'rotate-token ${parsed.label}' to replace it.\n`,
    );
    return 1;
  }

  const raw = generateRawToken();
  const hashed = await hashToken(raw);
  await mergeEnv(ws.envPath, { [envKey]: hashed });

  process.stdout.write(
    [
      `Token created for workspace '${ws.slug}' (label: ${envKey.slice(DASHBOARD_TOKEN_HASH_PREFIX.length)}).`,
      "",
      "⚠ Store this token now — it will not be shown again:",
      "",
      `  ${raw}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function runRotateToken(args: string[]): Promise<number> {
  const [label] = args;
  if (!label) {
    process.stderr.write(
      "cortex dashboard rotate-token: <label> required\n",
    );
    return 2;
  }

  const ws = await getActiveWorkspace();
  if (!ws) {
    process.stderr.write(
      "cortex dashboard rotate-token: no active workspace.\n",
    );
    return 1;
  }

  let envKey: string;
  try {
    envKey = envKeyForLabel(label);
  } catch (err) {
    process.stderr.write(
      `cortex dashboard rotate-token: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const existing = parseDotEnv(ws.envPath);
  if (!existing.has(envKey)) {
    process.stderr.write(
      `cortex dashboard rotate-token: label '${label}' does not exist. Use 'create-token --label ${label}' to create it.\n`,
    );
    return 1;
  }

  const raw = generateRawToken();
  const hashed = await hashToken(raw);
  await mergeEnv(ws.envPath, { [envKey]: hashed });

  process.stdout.write(
    [
      `Token rotated for workspace '${ws.slug}' (label: ${envKey.slice(DASHBOARD_TOKEN_HASH_PREFIX.length)}).`,
      "Existing browser sessions logged in with the old token will continue to work until the cookie expires; the old raw token can no longer be exchanged for a new session.",
      "",
      "⚠ Store this token now — it will not be shown again:",
      "",
      `  ${raw}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function runRevokeToken(args: string[]): Promise<number> {
  const [label] = args;
  if (!label) {
    process.stderr.write(
      "cortex dashboard revoke-token: <label> required\n",
    );
    return 2;
  }

  const ws = await getActiveWorkspace();
  if (!ws) {
    process.stderr.write(
      "cortex dashboard revoke-token: no active workspace.\n",
    );
    return 1;
  }

  let envKey: string;
  try {
    envKey = envKeyForLabel(label);
  } catch (err) {
    process.stderr.write(
      `cortex dashboard revoke-token: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const removed = await removeEnvKeys(ws.envPath, [envKey]);
  if (removed.length === 0) {
    process.stderr.write(
      `cortex dashboard revoke-token: label '${label}' not found.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `Token '${envKey.slice(DASHBOARD_TOKEN_HASH_PREFIX.length)}' revoked from workspace '${ws.slug}'.\n`,
  );
  return 0;
}

async function runListTokens(): Promise<number> {
  const ws = await getActiveWorkspace();
  if (!ws) {
    process.stderr.write(
      "cortex dashboard list-tokens: no active workspace.\n",
    );
    return 1;
  }
  const env = parseDotEnv(ws.envPath);
  const tokens = findTokenHashes(env);
  if (tokens.length === 0) {
    process.stdout.write(
      `No dashboard tokens configured for workspace '${ws.slug}'. Create one with 'cortex dashboard create-token'.\n`,
    );
    return 0;
  }
  process.stdout.write(`Dashboard tokens for workspace '${ws.slug}':\n`);
  for (const t of tokens) {
    process.stdout.write(`  ${t.label}\n`);
  }
  return 0;
}

// Re-export for consumers that want to drive the labels via code (tests).
export { labelForEnvKey };
