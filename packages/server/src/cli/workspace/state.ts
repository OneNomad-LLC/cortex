import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Cross-session state for Cortex: which workspace is active, the
 * state-file schema version, and any runtime bookkeeping that needs
 * to survive between CLI invocations. Stored at
 * `~/.cortex/state.json` (overridable via `PRZM_CORTEX_STATE_PATH`).
 */
export const stateSchema = z.object({
  version: z.literal(1).default(1),
  activeWorkspace: z.string().min(1).optional(),
});

export type CortexState = z.infer<typeof stateSchema>;

const EMPTY_STATE: CortexState = { version: 1 };

export function stateFilePath(): string {
  return (
    process.env.PRZM_CORTEX_STATE_PATH ??
    path.join(os.homedir(), ".cortex", "state.json")
  );
}

/**
 * SQLite database path for the dashboard widget cache (ADR-019). Lives
 * as a sibling of state.json so a single env override (PRZM_CORTEX_HOME) or
 * PRZM_CORTEX_STATE_PATH directory can move the entire user-state bundle.
 * Override directly via PRZM_CORTEX_DASHBOARD_CACHE_PATH for tests/dev.
 */
export function dashboardCachePath(): string {
  if (process.env.PRZM_CORTEX_DASHBOARD_CACHE_PATH) {
    return process.env.PRZM_CORTEX_DASHBOARD_CACHE_PATH;
  }
  return path.join(path.dirname(stateFilePath()), "dashboard-cache.db");
}

export async function readState(): Promise<CortexState> {
  const file = stateFilePath();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_STATE };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted state file — treat as empty so we don't crash every
    // CLI invocation. The user can `cortex workspace switch` to
    // rewrite it or manually delete ~/.cortex/state.json.
    return { ...EMPTY_STATE };
  }
  const result = stateSchema.safeParse(parsed);
  if (!result.success) return { ...EMPTY_STATE };
  return result.data;
}

export async function writeState(state: CortexState): Promise<void> {
  const file = stateFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  // Atomic write: temp file + rename. Keeps us from truncating the
  // state file mid-write if the process is killed.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, file);
}

/**
 * Update one field without requiring the caller to read the full
 * state first. Preserves any keys added by future versions of
 * Cortex that this CLI doesn't know about.
 */
export async function updateState(
  patch: Partial<CortexState>,
): Promise<CortexState> {
  const current = await readState();
  const next: CortexState = { ...current, ...patch };
  await writeState(next);
  return next;
}
