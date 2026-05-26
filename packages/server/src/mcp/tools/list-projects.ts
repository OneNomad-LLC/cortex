import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Include archived (inactive) projects too. Default: true — the
   *  tool reports the full registry unless you ask for active-only. */
  includeInactive: z.boolean().default(true),
});

interface ProjectRow {
  slug: string;
  name: string;
  description: string;
  active: boolean;
  aliases: string[];
  people: string[];
  sources: Record<string, unknown>;
  /** True only for the synthetic "default" project — the sentinel
   *  slug the ingest_* tools fall back to when none is given. It is
   *  not a real entry in projects.yaml. */
  implicit?: boolean;
}

interface Output {
  workspace: string;
  projects: ProjectRow[];
}

/**
 * The implicit "default" project. ingest_content/-repo/-file/note_create
 * accept `project: "default"` (or an omitted project) by bypassing the
 * taxonomy lookup, so it always exists even though nothing stores it.
 * Surfaced here so callers see every slug an ingest could legitimately
 * use. A fresh object each call so the caller can't mutate shared state.
 */
function defaultProjectRow(): ProjectRow {
  return {
    slug: "default",
    name: "Default",
    description:
      "Fallback project for ad-hoc ingest when no project is specified. " +
      "Implicit — not stored in projects.yaml.",
    active: true,
    aliases: [],
    people: [],
    sources: {},
    implicit: true,
  };
}

/**
 * List every project in the current workspace's taxonomy, plus the
 * implicit "default" project that ingest_* tools fall back to. Use it
 * to discover valid slugs/aliases before scoping an ingest, or to
 * confirm an add_project landed. Requires a bound session workspace.
 *
 * Note: the registry (config/projects.yaml) holds no created-date or
 * per-project memory count, so those aren't returned — a count would
 * mean one engram query per project, which isn't cheap enough to do
 * on a listing call.
 */
export const listProjects: McpTool<typeof inputSchema, Output> = {
  name: "list_projects",
  description:
    "List the projects Cortex knows about in the current workspace — " +
    "slug, name, aliases, and source mappings — plus the implicit " +
    "'default' project used when an ingest omits one. Pass " +
    "{ includeInactive: false } to hide archived projects. Requires a " +
    "bound session workspace.",
  inputSchema,

  async handler(input, ctx) {
    const ws = await requireSessionWorkspace();

    const projects: ProjectRow[] = ctx.taxonomy
      .listProjects({ activeOnly: !input.includeInactive })
      .map((p) => ({
        slug: p.slug,
        name: p.name,
        description: p.description,
        active: p.active,
        aliases: [...p.aliases],
        people: [...p.people],
        sources: { ...p.sources },
      }));

    return {
      workspace: ws.slug,
      projects: [defaultProjectRow(), ...projects],
    };
  },
};
