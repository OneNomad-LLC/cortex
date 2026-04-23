import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readState, updateState } from "./state.js";

/**
 * A Cortex workspace is one bundle of per-user config + secrets +
 * memory state, stored under `~/.cortex/workspaces/<slug>/`. Switching
 * workspaces flips the active pointer in `~/.cortex/state.json`;
 * subsequent CLI invocations resolve their config from the new
 * workspace's directory.
 */
export interface Workspace {
  slug: string;
  /** Absolute path to the workspace directory. */
  path: string;
  /** Absolute path to the workspace's cortex.yaml (may not exist yet). */
  configPath: string;
  /** Absolute path to the workspace's .env (may not exist yet). */
  envPath: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function workspacesRoot(): string {
  return (
    process.env.CORTEX_WORKSPACES_ROOT ??
    path.join(os.homedir(), ".cortex", "workspaces")
  );
}

export function workspacePath(slug: string): string {
  return path.join(workspacesRoot(), slug);
}

export function workspaceConfigPath(slug: string): string {
  return path.join(workspacePath(slug), "config", "cortex.yaml");
}

function toWorkspace(slug: string): Workspace {
  return {
    slug,
    path: workspacePath(slug),
    configPath: workspaceConfigPath(slug),
    envPath: path.join(workspacePath(slug), ".env"),
  };
}

/**
 * List every workspace on disk, newest name first. A workspace exists
 * if the directory has a `config/` subfolder — that's how we tell it
 * apart from stray files someone dropped under ~/.cortex/workspaces.
 */
export async function listWorkspaces(): Promise<Workspace[]> {
  const root = workspacesRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const workspaces: Workspace[] = [];
  for (const entry of entries) {
    if (!SLUG_RE.test(entry)) continue;
    const ws = toWorkspace(entry);
    try {
      const cfgDir = await stat(path.join(ws.path, "config"));
      if (cfgDir.isDirectory()) workspaces.push(ws);
    } catch {
      // No config dir — skip
    }
  }
  workspaces.sort((a, b) => a.slug.localeCompare(b.slug));
  return workspaces;
}

export async function findWorkspace(slug: string): Promise<Workspace | undefined> {
  const ws = toWorkspace(slug);
  try {
    const cfgDir = await stat(path.join(ws.path, "config"));
    return cfgDir.isDirectory() ? ws : undefined;
  } catch {
    return undefined;
  }
}

export async function getActiveWorkspace(): Promise<Workspace | undefined> {
  const state = await readState();
  if (!state.activeWorkspace) return undefined;
  return findWorkspace(state.activeWorkspace);
}

export function validateSlug(slug: string): { ok: true } | { ok: false; reason: string } {
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      reason: "slug must be kebab-case (a-z, 0-9, hyphens; must start with a letter or digit)",
    };
  }
  return { ok: true };
}

/**
 * Create a new workspace directory with empty config/ + .env scaffold.
 * If `fromPath` is provided and points at an existing cortex checkout
 * (or any directory containing `config/cortex.yaml`), the config and
 * .env are copied in so the new workspace matches the source setup.
 */
export async function createWorkspace(opts: {
  slug: string;
  fromPath?: string;
}): Promise<Workspace> {
  const validated = validateSlug(opts.slug);
  if (!validated.ok) throw new Error(validated.reason);

  const existing = await findWorkspace(opts.slug);
  if (existing) {
    throw new Error(`workspace '${opts.slug}' already exists at ${existing.path}`);
  }

  const ws = toWorkspace(opts.slug);
  await mkdir(path.join(ws.path, "config"), { recursive: true });

  if (opts.fromPath) {
    const sourceRoot = path.resolve(opts.fromPath);
    await copyConfigDir(sourceRoot, ws.path);
    await copyEnvFile(sourceRoot, ws.path);
  } else {
    // Blank slate — write a placeholder so the workspace is visible
    // to `listWorkspaces` and doesn't look half-created.
    await writeFile(
      ws.configPath,
      "# New workspace — run `cortex init` to populate.\n",
      "utf8",
    );
  }
  return ws;
}

export async function removeWorkspace(slug: string): Promise<void> {
  const ws = await findWorkspace(slug);
  if (!ws) throw new Error(`workspace '${slug}' does not exist`);
  await rm(ws.path, { recursive: true, force: true });
  const state = await readState();
  if (state.activeWorkspace === slug) {
    await updateState({ activeWorkspace: undefined });
  }
}

export async function switchWorkspace(slug: string): Promise<Workspace> {
  const ws = await findWorkspace(slug);
  if (!ws) {
    throw new Error(
      `workspace '${slug}' does not exist. Run \`cortex workspace list\` to see available workspaces.`,
    );
  }
  await updateState({ activeWorkspace: slug });
  return ws;
}

async function copyConfigDir(source: string, destRoot: string): Promise<void> {
  const srcCfg = path.join(source, "config");
  let entries: string[];
  try {
    entries = await readdir(srcCfg);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const destCfg = path.join(destRoot, "config");
  await mkdir(destCfg, { recursive: true });
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    // Skip backup files so workspaces don't inherit accidental clutter.
    if (entry.includes(".bak.")) continue;
    await copyFile(path.join(srcCfg, entry), path.join(destCfg, entry));
  }
}

async function copyEnvFile(source: string, destRoot: string): Promise<void> {
  const srcEnv = path.join(source, ".env");
  const destEnv = path.join(destRoot, ".env");
  try {
    await copyFile(srcEnv, destEnv);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
