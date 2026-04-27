import { z } from "zod";
import { loadCortexConfig } from "../../config.js";
import { deleteNote } from "../../notes/repo.js";
import { resolveNotesDir } from "../../notes/vault.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  slug: z.string().min(1),
});

interface Output {
  slug: string;
  path: string;
  deleted: boolean;
}

/**
 * Delete a cortex-authored note. Idempotent — `deleted: false` when
 * the slug didn't match an existing note. The obsidian adapter's
 * next sweep will remove the corresponding engram memories on its
 * usual cadence.
 */
export const noteDelete: McpTool<typeof inputSchema, Output> = {
  name: "note_delete",
  description:
    "Delete a cortex-authored note by slug. Idempotent — silently " +
    "no-ops when the slug doesn't exist (returns `deleted: false`). " +
    "The corresponding engram memories will fall out on the next " +
    "obsidian adapter sweep.",
  inputSchema,

  async handler(input) {
    const ws = await requireSessionWorkspace();
    const cfg = await loadCortexConfig(ws.configPath);
    const repo = resolveNotesDir(cfg);
    return deleteNote(repo, input.slug);
  },
};
