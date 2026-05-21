import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import { markSelf, upsertPerson } from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";
import type { Person } from "@onenomad/przm-cortex-core";

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)");

const inputSchema = z.object({
  /**
   * Kebab-case identifier for the user — used as the people.yaml key
   * and stamped on every "owner" field across the workspace's data.
   * Stable: don't change it casually.
   */
  slug: slugSchema,
  name: z.string().min(1),
  email: z.string().email(),
  /** Free-form role label — "Engineering Lead", "PM", "Designer". */
  role: z.string().optional(),
  /** Free-form team label — "Platform", "Delivery". */
  team: z.string().optional(),
  /** IANA zone, e.g. "America/New_York". Drives due-date resolution. */
  timezone: z.string().optional(),
  /** Working hours hint — "9am-5pm EST" / "async". */
  workHours: z.string().optional(),
  /** Project slugs the user is responsible for. */
  projects: z.array(slugSchema).optional(),
  /** Alternate names / handles for attendee-list matching. */
  aliases: z.array(z.string().min(1)).optional(),
});

interface Output {
  identity: Person;
  created: boolean;
}

/**
 * Upsert the workspace's `self` person. Clears `self: true` from any
 * other person so the invariant "exactly one self" holds. The slug
 * is stable across calls — re-running with the same slug patches in
 * new fields; running with a different slug transfers the `self`
 * flag.
 *
 * Workspace-scoped. Invalidates the in-memory taxonomy cache so the
 * next retrieval call sees the new identity without a server bounce.
 */
export const updateUserIdentityTool: McpTool<typeof inputSchema, Output> = {
  name: "update_user_identity",
  description:
    "Set or update the user identity for the current workspace. Marks " +
    "the supplied slug as `self: true` and clears the flag on any " +
    "other person (one self per workspace). Pass new fields as they " +
    "come in — name, email, role, team, timezone, working hours, " +
    "projects, aliases. Re-runnable; second call with the same slug " +
    "patches; second call with a different slug transfers the self " +
    "flag. Call this whenever the user shares identity info you " +
    "didn't already have.",
  inputSchema,

  async handler(input, ctx) {
    const ws = await requireSessionWorkspace();
    const paths = { repoRoot: ws.path };
    const patch: Partial<Person> & { slug: string } = {
      slug: input.slug,
      name: input.name,
      email: input.email,
      self: true,
    };
    if (input.role !== undefined) patch.role = input.role;
    if (input.team !== undefined) patch.team = input.team;
    if (input.timezone !== undefined) patch.timezone = input.timezone;
    if (input.workHours !== undefined) patch.workHours = input.workHours;
    if (input.projects !== undefined) patch.projects = input.projects;
    if (input.aliases !== undefined) patch.aliases = input.aliases;
    const { person, created } = await upsertPerson(paths, patch);
    await markSelf(paths, input.slug);
    ctx.invalidateTaxonomy?.(ws.slug);
    return { identity: { ...person, self: true }, created };
  },
};
