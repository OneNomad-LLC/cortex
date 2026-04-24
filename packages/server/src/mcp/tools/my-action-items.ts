import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Owner slug / name / email. Empty = every action item for everyone. */
  owner: z.string().default(""),
  /** Project slug or alias to scope. Empty = all projects. */
  project: z.string().default(""),
  /** Days back to consider items. */
  days: z.number().int().min(1).max(365).default(30),
  /** Include items marked done. Default false — open queue only. */
  includeDone: z.boolean().default(false),
  /** Cap on items returned. */
  limit: z.number().int().min(1).max(200).default(50),
});

interface ActionItemRow {
  sourceId: string;
  content: string;
  owner?: string;
  due?: string;
  status: "open" | "done" | "dropped" | "in_progress";
  project?: string | string[];
  source?: string;
  url?: string;
  date?: string;
}

interface Output {
  owner?: string;
  projectSlug?: string;
  since: string;
  open: ActionItemRow[];
  done?: ActionItemRow[];
  hint?: string;
}

export const myActionItems: McpTool<typeof inputSchema, Output> = {
  name: "my_action_items",
  description:
    "Return action items, filtered by owner and optionally by project. " +
    "Open items first, sorted by due date (undated last). Pass " +
    "`includeDone: true` to include completed items. Leave `owner` " +
    "blank for everyone's queue.",
  inputSchema,

  async handler(input, ctx) {
    const since = new Date(Date.now() - input.days * 86_400_000);

    let ownerSlug = input.owner.trim();
    let canonicalOwner: string | undefined = ownerSlug || undefined;
    if (ownerSlug) {
      const person = ctx.taxonomy.findPerson(ownerSlug);
      if (person) {
        ownerSlug = person.slug;
        canonicalOwner = person.slug;
      }
    }

    let projectSlug: string | undefined;
    if (input.project.trim().length > 0) {
      const project = ctx.taxonomy.findProject(input.project);
      if (!project) {
        return {
          open: [],
          since: since.toISOString(),
          hint: `No project matched '${input.project}'. Try list_projects.`,
        };
      }
      projectSlug = project.slug;
    }

    const query =
      [
        "action_item",
        ownerSlug ? `owner:${ownerSlug}` : "",
        projectSlug ? `project:${projectSlug}` : "",
      ]
        .filter((s) => s.length > 0)
        .join(" ");

    const memories = await ctx.engram
      .search({
        query,
        type: "action_item",
        ...(projectSlug ? { project: projectSlug } : {}),
        sinceIso: since.toISOString(),
        limit: input.limit * 2, // headroom for client-side owner filter
        domain: "work",
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      })
      .catch((err) => {
        ctx.logger.warn("my_action_items.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

    const rows: ActionItemRow[] = [];
    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const owner = tags.find((t) => t.startsWith("owner:"))?.slice("owner:".length);
      const due = tags.find((t) => t.startsWith("due:"))?.slice("due:".length);
      const status = (tags.find((t) => t.startsWith("status:"))?.slice("status:".length) ?? "open") as ActionItemRow["status"];

      if (ownerSlug && owner && owner !== ownerSlug) continue;

      rows.push({
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        content: mem.content,
        ...(owner ? { owner } : {}),
        ...(due ? { due } : {}),
        status,
        ...(meta.project !== undefined
          ? { project: meta.project as string | string[] }
          : {}),
        ...(typeof meta.source === "string" ? { source: meta.source } : {}),
        ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
        ...(typeof meta.date === "string"
          ? { date: meta.date }
          : mem.createdAt
            ? { date: mem.createdAt }
            : {}),
      });
    }

    rows.sort(sortActionRows);

    const open = rows.filter((r) => r.status !== "done" && r.status !== "dropped");
    const done = rows.filter((r) => r.status === "done");

    return {
      ...(canonicalOwner ? { owner: canonicalOwner } : {}),
      ...(projectSlug ? { projectSlug } : {}),
      since: since.toISOString(),
      open: open.slice(0, input.limit),
      ...(input.includeDone ? { done: done.slice(0, input.limit) } : {}),
    };
  },
};

function sortActionRows(a: ActionItemRow, b: ActionItemRow): number {
  // Undated items sink to the bottom.
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  if (a.due && b.due) return a.due.localeCompare(b.due);
  // Neither has a due date — newest first.
  return (b.date ?? "").localeCompare(a.date ?? "");
}
