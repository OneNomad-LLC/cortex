import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Slug or alias. Empty = unscoped / cross-project recent activity. */
  project: z.string().default(""),
  /** Days to look back. */
  days: z.number().int().min(1).max(180).default(7),
  /** Cap on memories pulled. */
  limit: z.number().int().min(1).max(200).default(40),
  /** Restrict to specific memory types. Empty = all types. */
  types: z.array(z.string()).default([]),
});

interface Bucket {
  type: string;
  items: Array<{
    id: string;
    title?: string;
    date?: string;
    source?: string;
    preview: string;
    url?: string;
  }>;
}

interface Output {
  projectSlug: string;
  projectName?: string;
  since: string;
  totalMemories: number;
  buckets: Bucket[];
  hint?: string;
}

export const catchMeUp: McpTool<typeof inputSchema, Output> = {
  name: "catch_me_up",
  description:
    "Return recent activity for a project (or across all projects if " +
    "`project` is blank), grouped by memory type. Great first tool to " +
    "run when coming back to work — shows decisions, meetings, docs, " +
    "and action items from the last N days.",
  inputSchema,

  async handler(input, ctx) {
    const since = new Date(Date.now() - input.days * 86_400_000);

    let projectSlug = "";
    let projectName: string | undefined;
    if (input.project.trim().length > 0) {
      const project = ctx.taxonomy.findProject(input.project);
      if (!project) {
        return {
          projectSlug: "",
          since: since.toISOString(),
          totalMemories: 0,
          buckets: [],
          hint: `No project matched '${input.project}'. Try list_projects for known slugs.`,
        };
      }
      projectSlug = project.slug;
      projectName = project.name;
    }

    const memories = await ctx.engram
      .search({
        query: projectSlug ? `project:${projectSlug}` : "recent activity",
        ...(projectSlug ? { project: projectSlug } : {}),
        sinceIso: since.toISOString(),
        limit: input.limit,
        domain: "work",
        ...(ctx.sessionWorkspace
          ? { workspace: ctx.sessionWorkspace }
          : {}),
      })
      .catch((err) => {
        ctx.logger.warn("catch_me_up.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

    const wantedTypes = input.types.length > 0 ? new Set(input.types) : null;
    const byType = new Map<string, Bucket["items"]>();

    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const type = (meta.type as string | undefined) ?? mem.type ?? "unknown";
      if (wantedTypes && !wantedTypes.has(type)) continue;

      const bucket = byType.get(type) ?? [];
      bucket.push({
        id: mem.id,
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        ...(typeof meta.date === "string"
          ? { date: meta.date }
          : mem.createdAt
            ? { date: mem.createdAt }
            : {}),
        ...(typeof meta.source === "string" ? { source: meta.source } : {}),
        preview: mem.content.slice(0, 240),
        ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
      });
      byType.set(type, bucket);
    }

    const typeOrder = [
      "brief",
      "meeting",
      "decision",
      "action_item",
      "doc",
      "note",
      "conversation",
      "code",
      "event",
      "commit",
      "digest",
      "unknown",
    ];
    const buckets: Bucket[] = [];
    for (const type of typeOrder) {
      const items = byType.get(type);
      if (items && items.length > 0) {
        items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
        buckets.push({ type, items });
        byType.delete(type);
      }
    }
    // Anything left over (unrecognized type) at the end.
    for (const [type, items] of byType) {
      items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      buckets.push({ type, items });
    }

    return {
      projectSlug,
      ...(projectName ? { projectName } : {}),
      since: since.toISOString(),
      totalMemories: memories.length,
      buckets,
    };
  },
};
