import { z } from "zod";
import { loadCortexConfig } from "../../config.js";
import { getNote, type NoteRead } from "../../notes/repo.js";
import { resolveNotesDir } from "../../notes/vault.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z
  .object({
    /** Cortex-authored notes — slug from frontmatter. */
    slug: z.string().optional(),
    /** Obsidian-authored notes — vault-relative POSIX path. */
    relativePath: z.string().optional(),
  })
  .refine((v) => v.slug !== undefined || v.relativePath !== undefined, {
    message: "note_get: pass either `slug` (cortex) or `relativePath` (obsidian)",
  });

/**
 * Read the full body + metadata of a single note. Companion to
 * `note_list`, which only returns previews. The dashboard editor
 * calls this when the user opens a note.
 *
 * Resolution rule: `slug` is preferred when present (faster path,
 * strict frontmatter); `relativePath` is the fallback for
 * obsidian-authored notes that live anywhere in the vault.
 */
export const noteGet: McpTool<typeof inputSchema, NoteRead> = {
  name: "note_get",
  description:
    "Fetch the full body + frontmatter of a single note. Pass `slug` " +
    "for cortex-authored notes (round-trippable through the dashboard " +
    "editor) or `relativePath` for any other markdown in the vault " +
    "(read-only — surfaces obsidian-authored docs in the same UI).",
  inputSchema,

  async handler(input) {
    const ws = await requireSessionWorkspace();
    const cfg = await loadCortexConfig(ws.configPath);
    const repo = resolveNotesDir(cfg);
    if (input.slug !== undefined) {
      return getNote(repo, { kind: "cortex", slug: input.slug });
    }
    return getNote(repo, { kind: "obsidian", relativePath: input.relativePath! });
  },
};
