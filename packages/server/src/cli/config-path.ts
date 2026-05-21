import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the effective cortex.yaml path for read-mode commands.
 *
 * Order (first hit wins):
 *   1. $PRZM_CORTEX_CONFIG_PATH — explicit override
 *   2. Active workspace from `~/.cortex/state.json` — the workspace
 *      user picked via `cortex workspace switch`. Read synchronously
 *      here so every command that touches config doesn't have to be
 *      async-aware.
 *   3. Walk up from cwd looking for `config/cortex.yaml` — handles
 *      `cortex <cmd>` run from any subdirectory of the repo (or from
 *      the repo root itself).
 *   4. `~/.cortex/config/cortex.yaml` — legacy global-install location,
 *      kept as a fallback for setups that predate workspaces.
 *   5. Fallback: cwd-relative `./config/cortex.yaml`, whether or not it
 *      exists. Commands that expect a real file surface a readable
 *      "not found" error; commands that bootstrap a new config (like
 *      `cortex init`) treat this as their write target.
 *
 * The returned path may not exist on disk — it's the *intended*
 * location. Callers read/write it and handle ENOENT themselves.
 */
export function resolveConfigPath(): string {
  const override = process.env.PRZM_CORTEX_CONFIG_PATH;
  if (override && override.length > 0) {
    if (path.isAbsolute(override)) return override;
    // Relative override values break global-install invocations (cwd may be
    // anywhere). Old `cortex init` templates wrote `./config/cortex.yaml`
    // into .env, so we keep this tolerant: only honor a relative override
    // if it actually resolves to a real file from cwd. Otherwise fall
    // through to walk-up / home discovery and pretend the var was unset.
    const fromRelative = path.resolve(process.cwd(), override);
    if (existsSync(fromRelative)) return fromRelative;
  }

  const fromWorkspace = resolveActiveWorkspaceConfig();
  if (fromWorkspace) return fromWorkspace;

  const fromTree = walkUpForConfig(process.cwd());
  if (fromTree) return fromTree;

  const homeDefault = path.join(os.homedir(), ".cortex", "config", "cortex.yaml");
  if (existsSync(homeDefault)) return homeDefault;

  return path.resolve(process.cwd(), "config", "cortex.yaml");
}

/**
 * Read `~/.cortex/state.json` synchronously and return the active
 * workspace's `cortex.yaml` path, if any. Sync on purpose: this hook
 * is called from every CLI command via `resolveConfigPath`, and making
 * it async would force every caller (doctor, sync, start, …) through
 * an awaited helper for zero gain — the state file is tiny.
 *
 * Returns undefined if no state file, no active workspace, or the
 * active workspace directory doesn't exist on disk. That lets
 * downstream fallbacks kick in naturally.
 */
function resolveActiveWorkspaceConfig(): string | undefined {
  const statePath =
    process.env.PRZM_CORTEX_STATE_PATH ??
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
    process.env.PRZM_CORTEX_WORKSPACES_ROOT ??
    path.join(os.homedir(), ".cortex", "workspaces");
  const candidate = path.join(root, slug, "config", "cortex.yaml");
  return existsSync(candidate) ? candidate : undefined;
}

function walkUpForConfig(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i += 1) {
    const candidate = path.join(dir, "config", "cortex.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
