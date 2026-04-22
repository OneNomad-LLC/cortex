import type { Widget } from "../types.js";

export interface PriorityRow {
  sourceId: string;
  content: string;
  project?: string | string[];
  owner?: string;
  due?: string;
  /** `action_item`, `decision`, `meeting`, ... — whatever Engram stored. */
  type?: string;
  source?: string;
  url?: string;
  date?: string;
  /** Why this item bubbled to the top. Helps the UI explain the ranking. */
  reason: "overdue" | "due-soon" | "just-nudged" | "fresh-decision";
}

export interface PrioritiesOutput {
  owner?: string;
  generatedAt: string;
  rows: PriorityRow[];
  /** Shown by the dashboard when we can tell the user "nothing to worry about". */
  note?: string;
}

/**
 * Cross-project "what needs my attention today" list. Ranks by:
 *   1. overdue action items (urgent)
 *   2. action items due in the next 48h (soon)
 *   3. action items touched in the last 24h (active work)
 *   4. decisions made in the last 24h (heads-up signal)
 *
 * Deliberately simple — the point of v1 is to prove the data plane, not to
 * do ranking magic. If ranking needs tuning it's one function to rewrite.
 */
export const prioritiesWidget: Widget<PrioritiesOutput> = {
  name: "priorities",
  description:
    "Top action items + fresh decisions across all projects, ranked by urgency.",

  async handler(query, ctx) {
    const owner = (query.get("owner") ?? "").trim();
    const limit = clampInt(query.get("limit"), 10, 50, 20);
    const daysBack = clampInt(query.get("days"), 1, 90, 14);

    const ownerSlug = resolveOwner(owner, ctx);
    const sinceIso = new Date(Date.now() - daysBack * 86_400_000).toISOString();
    const now = new Date();
    const soonCutoff = new Date(now.getTime() + 48 * 3_600_000);

    const [actionHits, decisionHits] = await Promise.all([
      ctx.engram
        .search({
          query:
            ["action_item", ownerSlug ? `owner:${ownerSlug}` : ""]
              .filter((s) => s.length > 0)
              .join(" ") || "action_item",
          type: "action_item",
          sinceIso,
          limit: limit * 3,
          domain: "work",
        })
        .catch((err) => {
          ctx.logger.warn("widget.priorities.action_search_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }),
      ctx.engram
        .search({
          query: "decision",
          type: "decision",
          sinceIso: new Date(Date.now() - 86_400_000).toISOString(),
          limit: Math.max(5, Math.floor(limit / 2)),
          domain: "work",
        })
        .catch((err) => {
          ctx.logger.warn("widget.priorities.decision_search_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }),
    ]);

    const rows: PriorityRow[] = [];

    for (const mem of actionHits) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const rowOwner = tags
        .find((t) => t.startsWith("owner:"))
        ?.slice("owner:".length);
      const due = tags.find((t) => t.startsWith("due:"))?.slice("due:".length);
      const status = tags
        .find((t) => t.startsWith("status:"))
        ?.slice("status:".length) ?? "open";

      if (status === "done" || status === "dropped") continue;
      if (ownerSlug && rowOwner && rowOwner !== ownerSlug) continue;

      const dueDate = due ? tryDate(due) : undefined;
      const touchedAt = tryDate(
        (typeof meta.date === "string" ? meta.date : mem.createdAt) ?? "",
      );

      let reason: PriorityRow["reason"];
      if (dueDate && dueDate < now) reason = "overdue";
      else if (dueDate && dueDate < soonCutoff) reason = "due-soon";
      else if (touchedAt && now.getTime() - touchedAt.getTime() < 86_400_000)
        reason = "just-nudged";
      else continue; // stale, undated, not interesting today

      rows.push({
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        content: mem.content,
        ...(meta.project !== undefined
          ? { project: meta.project as string | string[] }
          : {}),
        ...(rowOwner ? { owner: rowOwner } : {}),
        ...(due ? { due } : {}),
        type: "action_item",
        ...(typeof meta.source === "string" ? { source: meta.source } : {}),
        ...(typeof meta.source_url === "string"
          ? { url: meta.source_url }
          : {}),
        ...(touchedAt ? { date: touchedAt.toISOString() } : {}),
        reason,
      });
    }

    for (const mem of decisionHits) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      rows.push({
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        content: mem.content,
        ...(meta.project !== undefined
          ? { project: meta.project as string | string[] }
          : {}),
        type: "decision",
        ...(typeof meta.source === "string" ? { source: meta.source } : {}),
        ...(typeof meta.source_url === "string"
          ? { url: meta.source_url }
          : {}),
        ...(typeof meta.date === "string"
          ? { date: meta.date }
          : mem.createdAt
            ? { date: mem.createdAt }
            : {}),
        reason: "fresh-decision",
      });
    }

    rows.sort(rankRows);

    const out: PrioritiesOutput = {
      generatedAt: now.toISOString(),
      rows: rows.slice(0, limit),
    };
    if (ownerSlug) out.owner = ownerSlug;
    if (rows.length === 0) out.note = "Nothing urgent today.";
    return out;
  },
};

function resolveOwner(raw: string, ctx: { taxonomy: { findPerson(q: string): { slug: string } | undefined } }): string | undefined {
  if (!raw) return undefined;
  const person = ctx.taxonomy.findPerson(raw);
  return person ? person.slug : raw;
}

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

function tryDate(s: string): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const REASON_ORDER: Record<PriorityRow["reason"], number> = {
  overdue: 0,
  "due-soon": 1,
  "just-nudged": 2,
  "fresh-decision": 3,
};

function rankRows(a: PriorityRow, b: PriorityRow): number {
  const ra = REASON_ORDER[a.reason];
  const rb = REASON_ORDER[b.reason];
  if (ra !== rb) return ra - rb;
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return (b.date ?? "").localeCompare(a.date ?? "");
}
