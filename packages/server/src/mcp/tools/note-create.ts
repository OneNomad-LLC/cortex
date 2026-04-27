import { z } from "zod";
import { loadCortexConfig } from "../../config.js";
import { createNote } from "../../notes/repo.js";
import { resolveNotesDir } from "../../notes/vault.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  title: z.string().min(1),
  body: z.string().default(""),
  project: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

interface Output {
  slug: string;
  path: string;
  created: true;
}

/**
 * Create a new cortex-authored note. Writes a markdown file to
 * `<vault>/<obsidian.notesSubdir>/<slug>.md` with YAML frontmatter,
 * which the existing obsidian adapter will pick up on its next
 * sweep + index into engram.
 */
export const noteCreate: McpTool<typeof inputSchema, Output> = {
  name: "note_create",
  description:
    "Create a new cortex-authored note as markdown in the user's " +
    "obsidian vault. The slug is derived from the title (kebab-case, " +
    "with a numeric suffix on collision). Cortex sets `source: " +
    "cortex-notes` in frontmatter to distinguish dashboard-authored " +
    "notes from generic obsidian docs in later searches.",
  inputSchema,

  async handler(input) {
    const ws = await requireSessionWorkspace();
    const cfg = await loadCortexConfig(ws.configPath);
    const repo = resolveNotesDir(cfg);
    const fields: Parameters<typeof createNote>[1] = {
      title: input.title,
      body: input.body,
      tags: input.tags,
    };
    if (input.project !== undefined) fields.project = input.project;
    const handle = createNote(repo, fields);
    return {
      slug: handle.slug,
      path: handle.path,
      created: true,
    };
  },
};
