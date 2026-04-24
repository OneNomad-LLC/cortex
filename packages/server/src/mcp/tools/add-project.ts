import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { upsertProject } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)"),
  name: z.string().min(1),
  description: z.string().default(""),
  active: z.boolean().default(true),
  aliases: z.array(z.string().min(1)).default([]),
  people: z.array(z.string()).default([]),
});

interface Output {
  slug: string;
  created: boolean;
  project: Record<string, unknown>;
}

/**
 * Add a project to the taxonomy. Claude calls this after the user
 * describes a new work stream ("alpha is our platform migration").
 * People links can be empty at creation; use add_person first if
 * someone needs to be added before linking.
 */
export const addProject: McpTool<typeof inputSchema, Output> = {
  name: "add_project",
  description:
    "Add a project to the taxonomy. Use when the user introduces a " +
    "new work stream, client engagement, or internal initiative. " +
    "Aliases should include acronyms + informal names used in " +
    "meetings and Slack. Linked `people` must already exist in the " +
    "taxonomy (use add_person first for unknowns).",
  inputSchema,

  async handler(input, ctx) {
    const ws = await requireSessionWorkspace();
    const { project, created } = await upsertProject(
      { repoRoot: ws.path },
      input,
    );
    ctx.invalidateTaxonomy?.(ws.slug);
    return {
      slug: project.slug,
      created,
      project: project as unknown as Record<string, unknown>,
    };
  },
};
