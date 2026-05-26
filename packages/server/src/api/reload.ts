/**
 * Invoke the hot-reload hook if the server was built with one; log and
 * swallow failures so a reload error doesn't surface as a write
 * failure to the caller. Returns:
 *
 *   - the ReloadResult on success
 *   - `false` when no hook is wired (older builds / test harnesses)
 *   - `null` on thrown errors — the write still succeeded, just the
 *     reload didn't take effect
 *
 * Shared by every route that mutates config (config toggles, schedule
 * edits, wizard applies, workspace-file writes, /api/reload).
 */

import type { Logger } from "@onenomad/przm-cortex-core";
import type { ReloadResult } from "../hot-reload.js";
import type { DashboardApiOptions } from "./server.js";

export async function tryReload(
  opts: DashboardApiOptions,
  logger: Logger,
): Promise<ReloadResult | false | null> {
  if (!opts.reload) return false;
  try {
    return await opts.reload();
  } catch (err) {
    logger.warn("api.reload_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
