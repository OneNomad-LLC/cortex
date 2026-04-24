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
 * Parse a KEY=VALUE .env file into a Map without touching process.env.
 * Used when we need to load per-workspace secrets into a session-
 * scoped bag instead of mutating globals. Returns an empty Map if the
 * file is missing or unreadable.
 */
export function parseDotEnv(p: string): Map<string, string> {
  const result = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return result;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key) result.set(key, value);
  }
  return result;
}

/**
 * Minimal KEY=VALUE parser. Dedicated dotenv would be overkill for a
 * one-time read.
 *
 * Overwrites empty/undefined parent values but preserves non-empty ones,
 * so a user's shell export still wins over the on-disk .env.
 */
export function loadDotEnv(p: string): void {
  for (const [key, value] of parseDotEnv(p)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Strip one layer of surrounding double or single quotes from a
 * .env value. Matches what Docker Compose, python-dotenv, and
 * node-dotenv all do — the unquoted form is the canonical value.
 * Without this, `FOO="bar"` leaks into process.env as `"bar"` with
 * literal quote chars, breaking any downstream URL/regex validator.
 */
function unquote(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
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
