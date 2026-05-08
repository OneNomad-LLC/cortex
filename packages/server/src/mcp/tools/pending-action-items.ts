import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * Owner slug / name / email. Empty = every action item for everyone.
   * Renamed from `owner` to `assignee` in Cortex 0.2 — generic API,
   * no implicit "me" semantics.
   */
  assignee: z.string().default(""),
  /** Project slug or alias to scope. Empty = all projects. */
  project: z.string().default(""),
  /**
   * ISO-8601 lower bound for when the action item was last touched.
   * Default: 30 days before now. Pass an explicit value when you
   * want a longer or shorter look-back.
   */
  since: z.string().datetime({ offset: true }).optional(),
  /** Include items marked done. Default false — open queue only. */
  includeDone: z.boolean().default(false),
  /** Cap on items returned. */
  limit: z.number().int().min(1).max(200).default(50),
});

interface ActionItemRow {
  sourceId: string;
  content: string;
  assignee?: string;
  due?: string;
  status: "open" | "done" | "dropped" | "in_progress";
  project?: string | string[];
  source?: string;
  url?: string;
  date?: string;
}

interface Output {
  assignee?: string;
  projectSlug?: string;
  since: string;
  open: ActionItemRow[];
  done?: ActionItemRow[];
  hint?: string;
}

/**
 * Time-agnostic action-item queue. Replaces `my_action_items` —
 * the "my" was personal-assistant scope. Renamed `owner` → `assignee`
 * for clarity in the universal-knowledge framing.
 */
export const pendingActionItems: McpTool<typeof inputSchema, Output> = {
  name: "pending_action_items",
  description:
    "Return action items, filtered by assignee and optionally by project. " +
    "Open items first, sorted by due date (undated last). Pass " +
    "`includeDone: true` to include completed items. Leave `assignee` " +
    "blank for everyone's queue. `since` accepts an ISO-8601 timestamp; " +
    "default look-back is 30 days.",
  inputSchema,

  async handler(input, ctx) {
    const since = input.since
      ? new Date(input.since)
      : new Date(Date.now() - 30 * 86_400_000);

    let assigneeSlug = input.assignee.trim();
    let canonicalAssignee: string | undefined = assigneeSlug || undefined;
    if (assigneeSlug) {
      const person = ctx.taxonomy.findPerson(assigneeSlug);
      if (person) {
        assigneeSlug = person.slug;
        canonicalAssignee = person.slug;
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

    const query = [
      "action_item",
      assigneeSlug ? `owner:${assigneeSlug}` : "",
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
        limit: input.limit * 2, // headroom for client-side assignee filter
        domain: "work",
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      })
      .catch((err) => {
        ctx.logger.warn("pending_action_items.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

    const rows: ActionItemRow[] = [];
    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const assignee = tags
        .find((t) => t.startsWith("owner:"))
        ?.slice("owner:".length);
      const due = tags
        .find((t) => t.startsWith("due:"))
        ?.slice("due:".length);
      const status = (tags
        .find((t) => t.startsWith("status:"))
        ?.slice("status:".length) ?? "open") as ActionItemRow["status"];

      if (assigneeSlug && assignee && assignee !== assigneeSlug) continue;

      rows.push({
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        content: mem.content,
        ...(assignee ? { assignee } : {}),
        ...(due ? { due } : {}),
        status,
        ...(meta.project !== undefined
          ? { project: meta.project as string | string[] }
          : {}),
        ...(typeof meta.source === "string" ? { source: meta.source } : {}),
        ...(typeof meta.source_url === "string"
          ? { url: meta.source_url }
          : {}),
        ...(typeof meta.date === "string"
          ? { date: meta.date }
          : mem.createdAt
            ? { date: mem.createdAt }
            : {}),
      });
    }

    rows.sort(sortActionRows);

    const open = rows.filter(
      (r) => r.status !== "done" && r.status !== "dropped",
    );
    const done = rows.filter((r) => r.status === "done");

    return {
      ...(canonicalAssignee ? { assignee: canonicalAssignee } : {}),
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
