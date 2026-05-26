import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { addProjectDeduped } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)");

const inputSchema = z.object({
  /** Kebab-case identifier. Stable across mentions; written as the
   *  canonical `project` tag on every memory ingested under it. */
  slug: slugSchema,
  /** Human-readable display name. Defaults to the slug. */
  name: z.string().min(1).optional(),
  /** One-line description of the work stream. */
  description: z.string().optional(),
  /** Acronyms + informal names used in meetings, docs, and Slack so
   *  classification and get_project_context can resolve them. */
  aliases: z.array(z.string().min(1)).optional(),
});

interface Output {
  slug: string;
  created: boolean;
  already_exists: boolean;
  /** Present when already_exists: which input collided with an
   *  existing project (its slug, or one of its aliases). */
  matched_on?: { kind: "slug" | "alias"; value: string };
  project: Record<string, unknown>;
}

/**
 * Add a project to the current workspace's taxonomy. Call this after
 * the user describes a new work stream ("agn-rebuild is the AGN site
 * rebuild") so subsequent ingest_content / ingest_repo / note_create
 * calls can tag memories with the slug instead of falling back to the
 * implicit "default" project.
 *
 * Non-destructive and idempotent: if the slug or any alias already
 * resolves to a project, that project is returned with
 * `already_exists: true` and nothing is written — no duplicate, and
 * the existing entry is left untouched. Edit projects.yaml (or the
 * `cortex add projects` wizard) to change an existing project.
 */
export const addProject: McpTool<typeof inputSchema, Output> = {
  name: "add_project",
  description:
    "Add a project to the current workspace's taxonomy so ingests can " +
    "be scoped to it. Slug must be kebab-case. `aliases` should include " +
    "acronyms and informal names used in meetings and Slack. " +
    "Non-destructive: if the slug or any alias already maps to a " +
    "project, that project is returned with already_exists=true and " +
    "nothing is created. Requires a bound session workspace.",
  inputSchema,

  async handler(input, ctx) {
    const ws = await requireSessionWorkspace();

    const patch: Parameters<typeof addProjectDeduped>[1] = { slug: input.slug };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.aliases !== undefined) patch.aliases = input.aliases;

    const result = await addProjectDeduped({ repoRoot: ws.path }, patch);
    // Only the create path changes disk — drop the cached taxonomy so
    // the next ingest_content re-reads and accepts the new slug.
    if (result.created) ctx.invalidateTaxonomy?.(ws.slug);

    const out: Output = {
      slug: result.project.slug,
      created: result.created,
      already_exists: !result.created,
      project: result.project as unknown as Record<string, unknown>,
    };
    if (result.matchedOn) out.matched_on = result.matchedOn;
    return out;
  },
};
