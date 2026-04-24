import { z } from "zod";
import type { Person } from "@onenomad/cortex-core";
import type { McpTool, ToolContext } from "../tool.js";

const inputSchema = z.object({
  /** Slug or alias (name, acronym). Case/punctuation-insensitive for aliases. */
  project: z.string().min(1),
  /** How many recent items to include. 0 to skip the Engram query entirely. */
  recentLimit: z.number().int().min(0).max(50).default(10),
  /** Days to look back for recent activity. */
  recentDays: z.number().int().min(1).max(365).default(30),
});

interface ActivityItem {
  id: string;
  type?: string;
  title?: string;
  preview: string;
  date?: string;
  source?: string;
  url?: string;
}

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
  recent_activity: ActivityItem[];
  hint?: string;
}

export const getProjectContext: McpTool<typeof inputSchema, Output> = {
  name: "get_project_context",
  description:
    "Look up a project by slug or alias and return its description, " +
    "teammates, and recent activity from Engram (meetings, decisions, docs). " +
    "Use this to orient before digging into project-specific memories.",
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

    const recent =
      input.recentLimit > 0
        ? await fetchRecent(ctx, project.slug, input).catch((err) => {
            ctx.logger.warn("get_project_context.recent_failed", {
              project: project.slug,
              error: err instanceof Error ? err.message : String(err),
            });
            return [] as ActivityItem[];
          })
        : [];

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
      recent_activity: recent,
    };
  },
};

async function fetchRecent(
  ctx: ToolContext,
  projectSlug: string,
  input: z.output<typeof inputSchema>,
): Promise<ActivityItem[]> {
  const since = new Date(Date.now() - input.recentDays * 24 * 60 * 60 * 1000);
  const memories = await ctx.engram.search({
    query: `project:${projectSlug}`,
    project: projectSlug,
    sinceIso: since.toISOString(),
    limit: input.recentLimit,
    domain: "work",
    ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
  });

  return memories.map((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const item: ActivityItem = {
      id: m.id,
      preview: m.content.slice(0, 240),
    };
    const metaType = meta.type;
    if (typeof metaType === "string") item.type = metaType;
    else if (m.type) item.type = m.type;

    if (typeof meta.title === "string") item.title = meta.title;

    const metaDate = meta.date;
    if (typeof metaDate === "string") item.date = metaDate;
    else if (m.createdAt) item.date = m.createdAt;

    if (typeof meta.source === "string") item.source = meta.source;
    if (typeof meta.source_url === "string") item.url = meta.source_url;

    return item;
  });
}
