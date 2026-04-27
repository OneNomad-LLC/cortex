import type { Widget } from "../types.js";
import { filterByWorkspace } from "./_workspace-filter.js";

export interface ActionItemRow {
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

export interface MyActionItemsOutput {
  owner?: string;
  projectSlug?: string;
  since: string;
  open: ActionItemRow[];
  done?: ActionItemRow[];
  note?: string;
}

/**
 * The "what's on my plate" widget. Mirrors the `my_action_items` MCP tool but
 * shaped for a dashboard render: open queue first, optional done section, and
 * a friendly `note` string when the queue is empty.
 */
export const myActionItemsWidget: Widget<MyActionItemsOutput> = {
  name: "my-action-items",
  description:
    "Open action items for an owner, sorted by due date (undated last).",

  async handler(query, ctx) {
    const rawOwner = (query.get("owner") ?? "").trim();
    const rawProject = (query.get("project") ?? "").trim();
    const days = clampInt(query.get("days"), 1, 365, 30);
    const limit = clampInt(query.get("limit"), 1, 200, 50);
    const includeDone =
      (query.get("includeDone") ?? "").toLowerCase() === "true";

    const since = new Date(Date.now() - days * 86_400_000);

    let ownerSlug: string | undefined = rawOwner || undefined;
    let canonicalOwner: string | undefined = ownerSlug;
    if (rawOwner) {
      const person = ctx.taxonomy.findPerson(rawOwner);
      if (person) {
        ownerSlug = person.slug;
        canonicalOwner = person.slug;
      }
    }

    let projectSlug: string | undefined;
    if (rawProject) {
      const project = ctx.taxonomy.findProject(rawProject);
      if (!project) {
        return {
          open: [],
          since: since.toISOString(),
          note: `No project matched '${rawProject}'.`,
        };
      }
      projectSlug = project.slug;
    }

    const searchQuery = [
      "action_item",
      ownerSlug ? `owner:${ownerSlug}` : "",
      projectSlug ? `project:${projectSlug}` : "",
    ]
      .filter((s) => s.length > 0)
      .join(" ");

    const memoriesRaw = await ctx.engram
      .search({
        query: searchQuery,
        type: "action_item",
        ...(projectSlug ? { project: projectSlug } : {}),
        sinceIso: since.toISOString(),
        limit: limit * 2,
        domain: "work",
      })
      .catch((err) => {
        ctx.logger.warn("widget.my_action_items.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });
    // Phase 1b — workspace bleed fix.
    const memories = filterByWorkspace(memoriesRaw, ctx.workspace);

    const rows: ActionItemRow[] = [];
    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const owner = tags
        .find((t) => t.startsWith("owner:"))
        ?.slice("owner:".length);
      const due = tags.find((t) => t.startsWith("due:"))?.slice("due:".length);
      const status = (tags
        .find((t) => t.startsWith("status:"))
        ?.slice("status:".length) ?? "open") as ActionItemRow["status"];

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

    const out: MyActionItemsOutput = {
      since: since.toISOString(),
      open: open.slice(0, limit),
    };
    if (canonicalOwner) out.owner = canonicalOwner;
    if (projectSlug) out.projectSlug = projectSlug;
    if (includeDone) out.done = done.slice(0, limit);
    if (open.length === 0) {
      out.note = ownerSlug
        ? `Nothing open for ${ownerSlug} in the last ${days} days.`
        : `No open action items in the last ${days} days.`;
    }
    return out;
  },
};

function clampInt(
  raw: string | null,
  lo: number,
  hi: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function sortActionRows(a: ActionItemRow, b: ActionItemRow): number {
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  if (a.due && b.due) return a.due.localeCompare(b.due);
  return (b.date ?? "").localeCompare(a.date ?? "");
}
