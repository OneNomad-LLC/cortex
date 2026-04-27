import type { Widget } from "../types.js";
import { filterByWorkspace } from "./_workspace-filter.js";

export interface CodeActivityRow {
  project: string;
  count: number;
  languages: Array<{ language: string; count: number }>;
  lastTouchedIso: string;
  lastFile?: string;
  lastUrl?: string;
  lastSource?: string;
}

export interface CodeActivityOutput {
  since: string;
  rows: CodeActivityRow[];
  total: number;
  note?: string;
}

/**
 * Activity widget scoped to code (bitbucket/github adapters). Mirrors
 * recent-activity's shape but filtered to `type: code` and enriched with
 * language breakdown per project.
 *
 * Note on "recent": both the bitbucket and github adapters stamp
 * `date = now` at sync time, so this widget effectively answers "which
 * projects had code pulled into Engram in the last N days." Once the
 * github webhook path or a commit-aware fetcher lands, this becomes
 * real change signal without touching the widget.
 */
export const codeActivityWidget: Widget<CodeActivityOutput> = {
  name: "code-activity",
  description:
    "Code snapshots grouped by project, with language breakdown and last-touched file.",

  async handler(query, ctx) {
    const days = clampInt(query.get("days"), 1, 30, 3);
    const limit = clampInt(query.get("limit"), 1, 50, 10);
    const since = new Date(Date.now() - days * 86_400_000);

    const memoriesRaw = await ctx.engram
      .search({
        query: "code",
        type: "code",
        sinceIso: since.toISOString(),
        limit: 500,
        domain: "work",
      })
      .catch((err) => {
        ctx.logger.warn("widget.code_activity.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });
    // Phase 1b — workspace bleed fix.
    const memories = filterByWorkspace(memoriesRaw, ctx.workspace);

    const byProject = new Map<string, CodeActivityRow & { langs: Map<string, number> }>();
    let total = 0;

    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const dateStr =
        typeof meta.date === "string"
          ? meta.date
          : (mem.createdAt ?? undefined);
      if (!dateStr) continue;
      total += 1;

      const projects = normalizeProjects(meta.project);
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const language = tags
        .find((t) => t.startsWith("language:"))
        ?.slice("language:".length);

      for (const project of projects) {
        let row = byProject.get(project);
        if (!row) {
          row = {
            project,
            count: 0,
            languages: [],
            // Seed with sentinel so the first memory always wins the
            // "is this fresher?" comparison below.
            lastTouchedIso: "",
            langs: new Map(),
          };
          byProject.set(project, row);
        }
        row.count += 1;
        if (language) row.langs.set(language, (row.langs.get(language) ?? 0) + 1);
        if (dateStr.localeCompare(row.lastTouchedIso) > 0) {
          row.lastTouchedIso = dateStr;
          if (typeof meta.title === "string") row.lastFile = meta.title;
          else delete row.lastFile;
          if (typeof meta.source_url === "string") row.lastUrl = meta.source_url;
          else delete row.lastUrl;
          if (typeof meta.source === "string") row.lastSource = meta.source;
          else delete row.lastSource;
        }
      }
    }

    const rows: CodeActivityRow[] = Array.from(byProject.values())
      .map((r) => ({
        project: r.project,
        count: r.count,
        languages: Array.from(r.langs.entries())
          .map(([language, count]) => ({ language, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 4),
        lastTouchedIso: r.lastTouchedIso,
        ...(r.lastFile ? { lastFile: r.lastFile } : {}),
        ...(r.lastUrl ? { lastUrl: r.lastUrl } : {}),
        ...(r.lastSource ? { lastSource: r.lastSource } : {}),
      }))
      .sort((a, b) => b.lastTouchedIso.localeCompare(a.lastTouchedIso))
      .slice(0, limit);

    const out: CodeActivityOutput = {
      since: since.toISOString(),
      rows,
      total,
    };
    if (rows.length === 0) {
      out.note = `No code snapshots in the last ${days} days.`;
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
