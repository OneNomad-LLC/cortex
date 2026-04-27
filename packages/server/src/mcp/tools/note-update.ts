import { z } from "zod";
import { loadCortexConfig } from "../../config.js";
import { updateNote } from "../../notes/repo.js";
import { resolveNotesDir } from "../../notes/vault.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  slug: z.string().min(1),
  title: z.string().optional(),
  body: z.string().optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

interface Output {
  slug: string;
  path: string;
  updated: boolean;
  /** False when the patch was a no-op (content already matched). */
  changed: boolean;
}

/**
 * Patch fields on an existing cortex-authored note. Idempotent —
 * if the resulting content is identical to what's on disk, no write
 * happens and `changed: false` is returned.
 */
export const noteUpdate: McpTool<typeof inputSchema, Output> = {
  name: "note_update",
  description:
    "Update an existing cortex-authored note by slug. Specify only the " +
    "fields you want to change — title/body/project/tags. The note's " +
    "frontmatter `updated` timestamp is bumped only when the file " +
    "content actually changes (idempotent on re-saves of identical " +
    "content). Throws if the slug doesn't resolve to a note.",
  inputSchema,

  async handler(input) {
    const ws = await requireSessionWorkspace();
    const cfg = await loadCortexConfig(ws.configPath);
    const repo = resolveNotesDir(cfg);
    const fields: Parameters<typeof updateNote>[1] = { slug: input.slug };
    if (input.title !== undefined) fields.title = input.title;
    if (input.body !== undefined) fields.body = input.body;
    if (input.project !== undefined) fields.project = input.project;
    if (input.tags !== undefined) fields.tags = input.tags;
    const result = updateNote(repo, fields);
    return {
      slug: result.slug,
      path: result.path,
      updated: true,
      changed: result.changed,
    };
  },
};
