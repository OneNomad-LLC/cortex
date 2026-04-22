import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** When true, omit inactive projects. Default: true. */
  activeOnly: z.boolean().default(true),
});

interface ProjectRow {
  slug: string;
  name: string;
  description: string;
  active: boolean;
  aliases: string[];
  people: string[];
}

interface Output {
  projects: ProjectRow[];
}

export const listProjects: McpTool<typeof inputSchema, Output> = {
  name: "list_projects",
  description:
    "List the work projects Cortex knows about. By default only active " +
    "projects; pass { activeOnly: false } to include archived ones.",
  inputSchema,
  async handler(input, ctx) {
    const projects = ctx.taxonomy.listProjects({ activeOnly: input.activeOnly });
    return {
      projects: projects.map((p) => ({
        slug: p.slug,
        name: p.name,
        description: p.description,
        active: p.active,
        aliases: [...p.aliases],
        people: [...p.people],
      })),
    };
  },
};
