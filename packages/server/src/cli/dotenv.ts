import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Walk upward from startDir looking for a pnpm-workspace.yaml; return the
 * nearest directory that has one. Falls back to startDir.
 */
export function findRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/**
 * Minimal KEY=VALUE parser. Dedicated dotenv would be overkill for a
 * one-time read.
 *
 * Overwrites empty/undefined parent values but preserves non-empty ones,
 * so a user's shell export still wins over the on-disk .env.
 */
export function loadDotEnv(p: string): void {
  try {
    const text = readFileSync(p, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // non-fatal
  }
}

/**
 * Find the .env to load and read it into process.env. Order matches
 * the config resolver in `config-path.ts`:
 *   1. Active workspace's .env (`~/.cortex/workspaces/<slug>/.env`).
 *   2. Nearest .env walking up from cwd (the repo checkout case).
 *
 * Returning after the first hit means shell exports still win — the
 * loader never overwrites an already-set env var.
 */
export function autoLoadDotEnv(): void {
  const workspaceEnv = resolveActiveWorkspaceEnv();
  if (workspaceEnv && existsSync(workspaceEnv)) {
    loadDotEnv(workspaceEnv);
    return;
  }
  const root = findRepoRoot(process.cwd());
  const envPath = path.join(root, ".env");
  if (existsSync(envPath)) loadDotEnv(envPath);
}

/**
 * Sync twin of `resolveActiveWorkspaceConfig` — reads state.json to
 * find the active workspace's .env path. Kept local to this module
 * so dotenv isn't entangled with the workspace manager's async API.
 */
function resolveActiveWorkspaceEnv(): string | undefined {
  const statePath =
    process.env.CORTEX_STATE_PATH ??
    path.join(os.homedir(), ".cortex", "state.json");
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: { activeWorkspace?: string };
  try {
    parsed = JSON.parse(raw) as { activeWorkspace?: string };
  } catch {
    return undefined;
  }
  const slug = parsed.activeWorkspace;
  if (!slug) return undefined;
  const root =
    process.env.CORTEX_WORKSPACES_ROOT ??
    path.join(os.homedir(), ".cortex", "workspaces");
  return path.join(root, slug, ".env");
}
