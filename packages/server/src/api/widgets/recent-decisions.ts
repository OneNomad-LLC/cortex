import type { Widget } from "../types.js";
import { filterByWorkspace } from "./_workspace-filter.js";

export interface DecisionRow {
  sourceId: string;
  content: string;
  project?: string | string[];
  people?: string[];
  source?: string;
  url?: string;
  date?: string;
}

export interface RecentDecisionsOutput {
  projectSlug?: string;
  since: string;
  rows: DecisionRow[];
  note?: string;
}

/**
 * Fresh decisions across projects — the "what changed that I should know
 * about" signal. No ranking: just reverse-chronological within the window.
 * Decisions are the single most important memory type for a PM/delivery
 * role, so this widget earns its dashboard slot on signal density alone.
 */
export const recentDecisionsWidget: Widget<RecentDecisionsOutput> = {
  name: "recent-decisions",
  description:
    "Decisions made across projects in the last N days, newest first.",

  async handler(query, ctx) {
    const rawProject = (query.get("project") ?? "").trim();
    const days = clampInt(query.get("days"), 1, 90, 7);
    const limit = clampInt(query.get("limit"), 1, 100, 20);

    const since = new Date(Date.now() - days * 86_400_000);

    let projectSlug: string | undefined;
    if (rawProject) {
      const project = ctx.taxonomy.findProject(rawProject);
      if (!project) {
        return {
          rows: [],
          since: since.toISOString(),
          note: `No project matched '${rawProject}'.`,
        };
      }
      projectSlug = project.slug;
    }

    const memoriesRaw = await ctx.engram
      .search({
        query: projectSlug ? `decision project:${projectSlug}` : "decision",
        type: "decision",
        ...(projectSlug ? { project: projectSlug } : {}),
        sinceIso: since.toISOString(),
        limit: limit * 2,
        domain: "work",
      })
      .catch((err) => {
        ctx.logger.warn("widget.recent_decisions.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });
    // Phase 1b — workspace bleed fix.
    const memories = filterByWorkspace(memoriesRaw, ctx.workspace);

    const rows: DecisionRow[] = [];
    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const people = Array.isArray(meta.people)
        ? (meta.people as string[])
        : undefined;
      rows.push({
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        content: mem.content,
        ...(meta.project !== undefined
          ? { project: meta.project as string | string[] }
          : {}),
        ...(people && people.length > 0 ? { people } : {}),
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

    rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

    const out: RecentDecisionsOutput = {
      since: since.toISOString(),
      rows: rows.slice(0, limit),
    };
    if (projectSlug) out.projectSlug = projectSlug;
    if (rows.length === 0) {
      out.note = projectSlug
        ? `No decisions on '${projectSlug}' in the last ${days} days.`
        : `No decisions in the last ${days} days.`;
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
