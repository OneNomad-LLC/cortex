import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { upsertPerson } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)"),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().optional(),
  team: z.string().optional(),
  aliases: z.array(z.string().min(1)).default([]),
  projects: z.array(z.string()).default([]),
});

interface Output {
  slug: string;
  created: boolean;
  person: Record<string, unknown>;
}

/**
 * Add a person to the taxonomy. Claude typically calls this after
 * the user clarifies who someone is ("Alex is our staff engineer on
 * platform"). Use for collaborators, not the user themselves — that's
 * `update_user_identity`.
 */
export const addPerson: McpTool<typeof inputSchema, Output> = {
  name: "add_person",
  description:
    "Add a collaborator to the people taxonomy. Use when the user " +
    "clarifies who someone is (name, email, role, team). Aliases " +
    "should include nicknames + handles that show up in meeting " +
    "attendee lists, emails, and commits. Not for the user's own " +
    "identity — use `update_user_identity` for that.",
  inputSchema,

  async handler(input, ctx) {
    const ws = await requireSessionWorkspace();
    const { person, created } = await upsertPerson(
      { repoRoot: ws.path },
      input,
    );
    ctx.invalidateTaxonomy?.(ws.slug);
    return {
      slug: person.slug,
      created,
      person: person as unknown as Record<string, unknown>,
    };
  },
};
