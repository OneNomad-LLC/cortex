import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the effective cortex.yaml path for read-mode commands.
 *
 * Order (first hit wins):
 *   1. $CORTEX_CONFIG_PATH — explicit override
 *   2. Walk up from cwd looking for `config/cortex.yaml` — handles
 *      `cortex <cmd>` run from any subdirectory of the repo (or from
 *      the repo root itself).
 *   3. `~/.cortex/config/cortex.yaml` — the global-install location,
 *      matching the `~/.cortex/google-token.json` pattern used by
 *      @cortex/google-auth.
 *   4. Fallback: cwd-relative `./config/cortex.yaml`, whether or not it
 *      exists. Commands that expect a real file surface a readable
 *      "not found" error; commands that bootstrap a new config (like
 *      `cortex init`) treat this as their write target.
 *
 * The returned path may not exist on disk — it's the *intended*
 * location. Callers read/write it and handle ENOENT themselves.
 */
export function resolveConfigPath(): string {
  const override = process.env.CORTEX_CONFIG_PATH;
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

  const fromTree = walkUpForConfig(process.cwd());
  if (fromTree) return fromTree;

  const homeDefault = path.join(os.homedir(), ".cortex", "config", "cortex.yaml");
  if (existsSync(homeDefault)) return homeDefault;

  return path.resolve(process.cwd(), "config", "cortex.yaml");
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
