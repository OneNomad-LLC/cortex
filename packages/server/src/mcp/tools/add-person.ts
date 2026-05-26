import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { upsertPerson } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";
import type { Person } from "@onenomad/przm-cortex-core";

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)");

const inputSchema = z.object({
  /** Kebab-case identifier. Stable across mentions. */
  slug: slugSchema,
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().optional(),
  team: z.string().optional(),
  timezone: z.string().optional(),
  workHours: z.string().optional(),
  projects: z.array(slugSchema).optional(),
  aliases: z.array(z.string().min(1)).optional(),
});

interface Output {
  person: Person;
  created: boolean;
}

/**
 * Add (or patch) a non-self person to the workspace's people.yaml.
 * Use for teammates, stakeholders, customers, anyone the user
 * references frequently. Idempotent on slug — re-running merges new
 * fields into the existing entry.
 *
 * Does NOT touch the `self` flag. Use `update_user_identity` for
 * that.
 */
export const addPersonTool: McpTool<typeof inputSchema, Output> = {
  name: "add_person",
  description:
    "Add a person (teammate, stakeholder, customer) to the workspace's " +
    "people taxonomy. Idempotent on slug — re-runs patch fields onto " +
    "the existing entry. Use when the user mentions someone new and " +
    "the assistant wants the relationship to persist across sessions. " +
    "Does not affect the user identity (use update_user_identity " +
    "for that).",
  inputSchema,

  async handler(input, ctx) {
    const ws = await requireSessionWorkspace();
    const paths = { repoRoot: ws.path };
    const patch: Partial<Person> & { slug: string } = {
      slug: input.slug,
      name: input.name,
      email: input.email,
    };
    if (input.role !== undefined) patch.role = input.role;
    if (input.team !== undefined) patch.team = input.team;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (input.workHours !== undefined) patch.workHours = input.workHours;
    if (input.projects !== undefined) patch.projects = input.projects;
    if (input.aliases !== undefined) patch.aliases = input.aliases;
    const result = await upsertPerson(paths, patch);
    ctx.invalidateTaxonomy?.(ws.slug);
    return result;
  },
};
