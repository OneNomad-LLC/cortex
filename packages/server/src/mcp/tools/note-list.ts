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
 * List cortex-authored notes. Reads frontmatter + first ~200 chars of
 * body from each `.md` file in the cortex-notes subdir; no engram
 * round-trip. Sorted by `updated` desc.
 */
export const noteList: McpTool<typeof inputSchema, Output> = {
  name: "note_list",
  description:
    "List cortex-authored notes — slug, title, project, tags, " +
    "updated, and a 200-char preview per note. Filesystem-only " +
    "(no engram call). Filter by `project` to scope to one " +
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
