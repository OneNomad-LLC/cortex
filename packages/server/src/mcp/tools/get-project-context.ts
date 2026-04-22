import { z } from "zod";
import type { Person } from "@cortex/core";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Slug or alias (name, acronym). Case/punctuation-insensitive for aliases. */
  project: z.string().min(1),
});

interface Output {
  found: boolean;
  project?: {
    slug: string;
    name: string;
    description: string;
    active: boolean;
    aliases: string[];
    sources: Record<string, unknown>;
  };
  people?: Array<{
    slug: string;
    name: string;
    email: string;
    role?: string;
  }>;
  /**
   * Engram-backed recent activity (meetings, decisions, docs) will land here
   * once the real Engram client is wired in. Empty array in Phase 2.
   */
  recent_activity: unknown[];
  hint?: string;
}

export const getProjectContext: McpTool<typeof inputSchema, Output> = {
  name: "get_project_context",
  description:
    "Look up a project by slug or alias and return its description, " +
    "teammates, and (once wired) recent activity from Engram. Use this " +
    "to orient before digging into project-specific memories.",
  inputSchema,
  async handler(input, ctx) {
    const project = ctx.taxonomy.findProject(input.project);
    if (!project) {
      return {
        found: false,
        recent_activity: [],
        hint: `No project matched '${input.project}'. Try list_projects to see known slugs and aliases.`,
      };
    }

    const people: Person[] = [];
    for (const slug of project.people) {
      const person = ctx.taxonomy.findPersonBySlug(slug);
      if (person) people.push(person);
    }

    return {
      found: true,
      project: {
        slug: project.slug,
        name: project.name,
        description: project.description,
        active: project.active,
        aliases: [...project.aliases],
        sources: { ...project.sources },
      },
      people: people.map((p) => ({
        slug: p.slug,
        name: p.name,
        email: p.email,
        ...(p.role ? { role: p.role } : {}),
      })),
      recent_activity: [],
    };
  },
};
