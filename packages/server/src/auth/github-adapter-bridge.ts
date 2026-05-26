/**
 * Bridge OAuth Device Flow → GitHub adapter config.
 *
 * When a user completes "Continue with GitHub" in the dashboard, the
 * OAuth access token they granted Cortex is the SAME credential
 * `adapter-github` needs to pull repos. Re-asking them for a personal
 * access token in the adapter wizard is friction we should eliminate.
 *
 * On successful Device Flow auth (post-allowlist check), this module:
 *   1. Writes `GITHUB_TOKEN=<oauth-token>` to the workspace `.env`
 *      so adapter-github's `requiredSecrets` lookup finds it.
 *   2. Marks the token source as `oauth` via
 *      `PRZM_CORTEX_GITHUB_TOKEN_SOURCE` so the wizard renderer +
 *      Connectors page can show "Connected via OAuth" instead of
 *      pretending the user pasted a PAT.
 *   3. Adds a minimal `adapters.github` block to `cortex.yaml` if one
 *      isn't already there, with `enabled: true` and an empty
 *      `repos: []`. The user picks repos via
 *      `/_dashboard/integrations/github` (Slice B's table). The
 *      adapter no-ops on empty repos at sync time.
 *
 * Idempotent. Won't clobber a manually-pasted PAT (we only write
 * GITHUB_TOKEN when it's absent OR previously OAuth-sourced — so a
 * later OAuth login refreshes a stale OAuth token but doesn't
 * overwrite a PAT the operator deliberately set).
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { mergeEnv } from "../cli/config-mutation.js";
import { parseDotEnv } from "../cli/dotenv.js";
import type { Workspace } from "../cli/workspace/manager.js";

/**
 * Outcome the route handler can surface to the UI / logger. The
 * Connectors page reads `source === 'oauth'` to flip the GitHub card
 * to "Connected via OAuth" with the avatar of whoever last signed in.
 */
export interface AdapterBridgeOutcome {
  /** Whether GITHUB_TOKEN was written this call (i.e. wasn't already OAuth-sourced + matching). */
  wroteToken: boolean;
  /** Whether the adapters.github YAML block was added this call. */
  enabledAdapter: boolean;
  /** Current source of the GITHUB_TOKEN env var after this call. */
  tokenSource: "oauth" | "pat" | "absent";
  /** Hint for the caller — empty when nothing-to-do; populated when we skipped to preserve a PAT. */
  skippedReason?: "pat_already_set";
}

/**
 * Apply the OAuth token + minimal adapter config to the workspace.
 * Returns what changed so the caller can log / surface to the user.
 */
export async function bridgeGithubAdapterConfig(opts: {
  workspace: Workspace;
  oauthToken: string;
}): Promise<AdapterBridgeOutcome> {
  const { workspace, oauthToken } = opts;
  const outcome: AdapterBridgeOutcome = {
    wroteToken: false,
    enabledAdapter: false,
    tokenSource: "absent",
  };

  // 1. Token write — respect a manually-set PAT.
  const env = await parseDotEnv(workspace.envPath);
  const existingToken = env.get("GITHUB_TOKEN");
  const existingSource = env.get("PRZM_CORTEX_GITHUB_TOKEN_SOURCE");

  if (existingToken && existingSource !== "oauth") {
    // Operator set a PAT explicitly. Leave it alone — they may be
    // using a fine-grained token with narrower scopes than the OAuth
    // session, and we shouldn't swap it under their feet.
    outcome.tokenSource = "pat";
    outcome.skippedReason = "pat_already_set";
  } else if (!existingToken || existingToken !== oauthToken) {
    await mergeEnv(workspace.envPath, {
      GITHUB_TOKEN: oauthToken,
      PRZM_CORTEX_GITHUB_TOKEN_SOURCE: "oauth",
    });
    outcome.wroteToken = true;
    outcome.tokenSource = "oauth";
  } else {
    // Token unchanged from a prior OAuth bridge. Same value, no write.
    outcome.tokenSource = "oauth";
  }

  // 2. cortex.yaml adapter block. Skip when adapter is already
  // configured — we don't want to clobber a user's `repos` or
  // `repoToProject` mapping.
  outcome.enabledAdapter = await ensureGithubAdapterBlock(workspace.configPath);

  return outcome;
}

/**
 * Read the workspace's cortex.yaml (preferring cortex.local.yaml when
 * present), add `adapters.github: { enabled: true, repos: [] }` if it
 * isn't there, atomic-write. Returns true when we actually added the
 * block, false when it already existed.
 *
 * This is a narrow YAML mutation — config-mutation.ts's full
 * `applyWizardResult` machinery is overkill for "ensure one key
 * exists." We do the read-or-create + atomic rename ourselves.
 */
async function ensureGithubAdapterBlock(
  baseConfigPath: string,
): Promise<boolean> {
  const localPath = baseConfigPath.replace(/\.yaml$/, ".local.yaml");
  const targetPath = existsSync(localPath) ? localPath : baseConfigPath;
  const raw = existsSync(targetPath)
    ? await readFile(targetPath, "utf8")
    : "";
  const doc = (raw ? (parseYaml(raw) ?? {}) : {}) as Record<string, unknown>;
  const adapters = ((doc.adapters as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  if (adapters.github) {
    // Adapter is already declared. Even if `enabled: false`, the
    // operator owns that choice — we don't flip it back.
    return false;
  }
  adapters.github = { enabled: true, repos: [] };
  doc.adapters = adapters;

  const next = stringifyYaml(doc, { lineWidth: 0 });
  // Ensure the parent dir exists — workspaces created without an
  // explicit `cortex init` may not have `config/` yet.
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, next, "utf8");
  await rename(tmpPath, targetPath);
  return true;
}
