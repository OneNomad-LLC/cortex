import { join } from "node:path";
import { obsidianConfigSchema } from "@onenomad/cortex-adapter-obsidian";
import type { CortexConfig } from "../config.js";

/**
 * Resolve the cortex-notes write target inside the user's obsidian
 * vault. Throws a clear error when obsidian isn't configured —
 * cortex-notes are markdown files in the vault, so no obsidian =
 * no notes.
 *
 * Returns absolute paths so the repo layer doesn't have to think
 * about CWD.
 */
export function resolveNotesDir(cfg: CortexConfig): { vaultPath: string; notesDir: string } {
  const entry = cfg.adapters.obsidian;
  if (!entry || !entry.enabled) {
    throw new Error(
      "notes: the obsidian adapter is not enabled. Run `cortex add obsidian` to point cortex at your vault before using notes.",
    );
  }
  const parsed = obsidianConfigSchema.safeParse(entry.config);
  if (!parsed.success) {
    throw new Error(
      `notes: obsidian adapter config is invalid. ${parsed.error.message}`,
    );
  }
  const vaultPath = parsed.data.vaultPath;
  const subdir = parsed.data.notesSubdir;
  return {
    vaultPath,
    notesDir: join(vaultPath, subdir),
  };
}
