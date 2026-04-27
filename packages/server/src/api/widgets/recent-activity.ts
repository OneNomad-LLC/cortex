import type { Widget } from "../types.js";
import { filterByWorkspace } from "./_workspace-filter.js";

export interface RecentActivityProjectRow {
  project: string;
  count: number;
  lastTouchedIso: string;
  /** Most-recent item's type (meeting, decision, action_item, ...). */
  lastType?: string;
  /** Single-line preview of the newest item. */
  lastContent?: string;
  /** Where that item came from (loom, confluence, ...). */
  lastSource?: string;
  lastUrl?: string;
}

export interface RecentActivityOutput {
  since: string;
  projects: RecentActivityProjectRow[];
  total: number;
  note?: string;
}

/**
 * Cross-project "what moved recently" widget. Groups recent memories by
 * project and shows the most-recent item per group — handy when you've
 * been context-switching and want a quick visual of which projects have
 * been active vs quiet.
 *
 * Cross-project items (where `project` is an array) are counted against
 * every listed project, so a memory tagged `[alpha, beta]` bumps both.
 */
export const recentActivityWidget: Widget<RecentActivityOutput> = {
  name: "recent-activity",
  description:
    "Per-project activity summary over the last N days, newest first.",

  async handler(query, ctx) {
    const days = clampInt(query.get("days"), 1, 30, 3);
    const limit = clampInt(query.get("limit"), 1, 50, 12);

    const since = new Date(Date.now() - days * 86_400_000);

    const memoriesRaw = await ctx.engram
      .search({
        query: "",
        sinceIso: since.toISOString(),
        limit: 500, // broad fetch — ranking happens client-side by project
        domain: "work",
      })
      .catch((err) => {
        ctx.logger.warn("widget.recent_activity.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });
    // Phase 1b — workspace bleed fix.
    const memories = filterByWorkspace(memoriesRaw, ctx.workspace);

    const byProject = new Map<string, RecentActivityProjectRow>();
    let total = 0;

    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const dateStr =
        typeof meta.date === "string"
          ? meta.date
          : (mem.createdAt ?? undefined);
      if (!dateStr) continue;
      const when = new Date(dateStr);
      if (Number.isNaN(when.getTime())) continue;
      total += 1;

      const projects = normalizeProjects(meta.project);
      for (const project of projects) {
        const existing = byProject.get(project);
        if (!existing) {
          byProject.set(project, {
            project,
            count: 1,
            lastTouchedIso: dateStr,
            ...(typeof mem.type === "string" ? { lastType: mem.type } : {}),
            lastContent: truncate(mem.content, 140),
            ...(typeof meta.source === "string"
              ? { lastSource: meta.source }
              : {}),
            ...(typeof meta.source_url === "string"
              ? { lastUrl: meta.source_url }
              : {}),
          });
          continue;
        }
        existing.count += 1;
        if (dateStr.localeCompare(existing.lastTouchedIso) > 0) {
          existing.lastTouchedIso = dateStr;
          if (typeof mem.type === "string") existing.lastType = mem.type;
          else delete existing.lastType;
          existing.lastContent = truncate(mem.content, 140);
          if (typeof meta.source === "string") existing.lastSource = meta.source;
          else delete existing.lastSource;
          if (typeof meta.source_url === "string")
            existing.lastUrl = meta.source_url;
          else delete existing.lastUrl;
        }
      }
    }

    const projects = Array.from(byProject.values())
      .sort((a, b) => b.lastTouchedIso.localeCompare(a.lastTouchedIso))
      .slice(0, limit);

    const out: RecentActivityOutput = {
      since: since.toISOString(),
      projects,
      total,
    };
    if (projects.length === 0) {
      out.note = `No activity in the last ${days} days.`;
    }
    return out;
  },
};

function normalizeProjects(raw: unknown): string[] {
  if (typeof raw === "string" && raw.length > 0) return [raw];
  if (Array.isArray(raw)) {
    return raw.filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
  }
  return ["_unassigned"];
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}
