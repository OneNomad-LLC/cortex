import { z } from "zod";
import { loadCortexConfig } from "../../config.js";
import { listNotes, type NoteSummary } from "../../notes/repo.js";
import { resolveNotesDir } from "../../notes/vault.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  project: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

interface Output {
  notes: NoteSummary[];
}

/**
 * Federated listing across the whole obsidian vault. Returns both
 * cortex-authored notes (kind=cortex, dashboard-editable) and
 * obsidian-authored notes anywhere else in the vault (kind=obsidian,
 * read-only in the dashboard). Filesystem-only — no engram round-trip.
 * Sorted by `updated` desc.
 */
export const noteList: McpTool<typeof inputSchema, Output> = {
  name: "note_list",
  description:
    "List every markdown note in the user's obsidian vault — both " +
    "cortex-authored (kind: 'cortex', editable from the dashboard) " +
    "and obsidian-authored (kind: 'obsidian', read-only in the " +
    "dashboard). Each entry has id, title, project, tags, updated, " +
    "and a 200-char preview. Filter by `project` to scope to one " +
    "engagement. Sorted newest-updated first.",
  inputSchema,

  async handler(input) {
    const ws = await requireSessionWorkspace();
    const cfg = await loadCortexConfig(ws.configPath);
    const repo = resolveNotesDir(cfg);
    const opts: Parameters<typeof listNotes>[1] = { limit: input.limit };
    if (input.project !== undefined) opts.project = input.project;
    return { notes: listNotes(repo, opts) };
  },
};
