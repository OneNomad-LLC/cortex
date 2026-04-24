import { z } from "zod";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import {
  markSelf,
  readPeople,
  upsertPerson,
} from "../../taxonomy-mutation.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * Kebab-case slug used everywhere else in Cortex ("matt", "alex").
   * Optional — if omitted and a self entry exists, we patch it; if
   * omitted and no self entry exists, we derive one from the name.
   */
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)")
    .optional(),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.string().optional(),
  team: z.string().optional(),
  timezone: z.string().optional(),
  workHours: z.string().optional(),
  /** Alternate names / handles that may appear in meetings, emails, code. */
  aliases: z.array(z.string().min(1)).optional(),
});

interface Output {
  slug: string;
  created: boolean;
  identity: Record<string, unknown>;
  warning?: string | undefined;
}

/**
 * Patch the user's identity record. Called whenever the user reveals
 * something Cortex doesn't know yet — a name, email, team affiliation,
 * a nickname that shows up in emails, etc. Partial updates are fine;
 * only the fields you pass are changed.
 */
export const updateUserIdentity: McpTool<typeof inputSchema, Output> = {
  name: "update_user_identity",
  description:
    "Save or patch the user's identity record. Use whenever the user " +
    "reveals identifying info — 'I'm Matt, on the platform team' → " +
    "call this with { name: 'Matt', team: 'platform' }. Partial " +
    "updates are safe; only fields you pass change. Marks the person " +
    "as the Cortex self — exactly one person carries that flag.",
  inputSchema,

  async handler(input, ctx) {
    // Session-scoped: this writes to the workspace the current MCP
    // session is bound to, not the global state.json active pointer.
    const ws = await requireSessionWorkspace();
    const paths = { repoRoot: ws.path };

    // Figure out which slug to write against. Priority:
    //   1. Explicit slug arg
    //   2. Existing self entry
    //   3. Derived from name
    const people = await readPeople(paths);
    const existingSelf = people.find((p) => p.self === true);
    const slug =
      input.slug ??
      existingSelf?.slug ??
      (input.name ? slugify(input.name) : undefined);
    if (!slug) {
      throw new Error(
        "can't derive a slug — pass `slug` or `name` (used to generate one)",
      );
    }

    const patch = {
      slug,
      self: true,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.team !== undefined ? { team: input.team } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.workHours !== undefined ? { workHours: input.workHours } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
    };

    const { person, created } = await upsertPerson(paths, patch);
    // Ensure exactly one self.
    await markSelf(paths, slug);
    // Drop the cached taxonomy for this workspace so the next read
    // sees the new self entry rather than a stale snapshot.
    ctx.invalidateTaxonomy?.(ws.slug);

    return {
      slug: person.slug,
      created,
      identity: person as unknown as Record<string, unknown>,
      warning: created
        ? "Identity saved. Hot reload will pick this up immediately for future tools, but a few already-running widgets may still see the old taxonomy until the next memory ingest."
        : undefined,
    };
  },
};

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "me";
}
