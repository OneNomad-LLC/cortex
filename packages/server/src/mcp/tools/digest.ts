import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * ISO-8601 lower bound for "recent activity" + open action items.
   * Default: 24h before `until` (or before now if `until` is omitted).
   */
  since: z.string().datetime({ offset: true }).optional(),
  /**
   * ISO-8601 upper bound for "upcoming events" and the right edge of
   * the recent window. Default: 24h ahead of now.
   */
  until: z.string().datetime({ offset: true }).optional(),
  /** Optional project slug to scope the digest. */
  project: z.string().default(""),
  /** Owner slug / name / email for action items. Empty = everyone. */
  assignee: z.string().default(""),
  /** Include classifier review-queue count in the summary. */
  includeUnclassified: z.boolean().default(true),
});

interface DigestAction {
  content: string;
  assignee?: string;
  due?: string;
  sourceId: string;
}

interface DigestEvent {
  title?: string;
  start?: string;
  url?: string;
  project?: string;
}

interface DigestRecent {
  type: string;
  title?: string;
  preview: string;
  date?: string;
  source?: string;
}

interface Output {
  generatedAt: string;
  window: { since: string; until: string };
  upcoming: DigestEvent[];
  openActionItems: DigestAction[];
  overdueActionItems: DigestAction[];
  recent: {
    decisions: DigestRecent[];
    briefs: DigestRecent[];
    other: DigestRecent[];
  };
  unclassifiedQueueSize?: number;
  summary: {
    upcomingCount: number;
    actionItemsOpen: number;
    actionItemsOverdue: number;
    recentDecisions: number;
    recentBriefs: number;
  };
}

/**
 * Time-agnostic activity digest. Caller passes an explicit
 * `since` / `until` window; defaults give a 24-hour spread around
 * "now" so unparameterized calls behave like the old `todays_digest`
 * tool. Renamed and reshaped for Cortex 0.2 (universal-knowledge).
 */
export const digest: McpTool<typeof inputSchema, Output> = {
  name: "digest",
  description:
    "Activity digest across an arbitrary time window. Returns " +
    "upcoming events, open + overdue action items, recent decisions / " +
    "briefs / other activity, and the unclassified-queue size. " +
    "`since` / `until` accept ISO-8601 timestamps; defaults to a 24h " +
    "window centered on now. Optional `project` and `assignee` filters.",
  inputSchema,

  async handler(input, ctx) {
    const now = new Date();
    // When the caller doesn't pass `until`, default to "now + 24h"
    // so the upcoming-events half of the digest has a sensible
    // forward-looking window. When they DO pass it, honor it
    // verbatim — even if it's in the past (yields 0 upcoming events,
    // which is the correct semantics for a backward-looking range).
    const until = input.until
      ? new Date(input.until)
      : new Date(now.getTime() + 24 * 3_600_000);
    const since = input.since
      ? new Date(input.since)
      : new Date(now.getTime() - 24 * 3_600_000);
    const upcomingTo = until;

    let assigneeSlug: string | undefined;
    if (input.assignee.trim()) {
      const person = ctx.taxonomy.findPerson(input.assignee);
      assigneeSlug = person?.slug ?? input.assignee;
    }

    let projectSlug: string | undefined;
    if (input.project.trim().length > 0) {
      const project = ctx.taxonomy.findProject(input.project);
      if (project) projectSlug = project.slug;
    }

    const workspaceFilter = ctx.sessionWorkspace
      ? { workspace: ctx.sessionWorkspace }
      : {};
    const projectFilter = projectSlug ? { project: projectSlug } : {};

    const [upcoming, actionMems, recentDecisions, recentBriefs, recentOther, unclassified] =
      await Promise.all([
        ctx.engram
          .search({
            query: "upcoming calendar event",
            type: "event",
            sinceIso: now.toISOString(),
            limit: 10,
            domain: "work",
            ...projectFilter,
            ...workspaceFilter,
          })
          .catch(() => []),
        ctx.engram
          .search({
            query: assigneeSlug
              ? `action_item owner:${assigneeSlug}`
              : "action_item",
            type: "action_item",
            sinceIso: new Date(
              since.getTime() - 60 * 86_400_000,
            ).toISOString(),
            limit: 60,
            domain: "work",
            ...projectFilter,
            ...workspaceFilter,
          })
          .catch(() => []),
        ctx.engram
          .search({
            query: "decision",
            type: "decision",
            sinceIso: since.toISOString(),
            limit: 5,
            domain: "work",
            ...projectFilter,
            ...workspaceFilter,
          })
          .catch(() => []),
        ctx.engram
          .search({
            query: "brief",
            type: "brief",
            sinceIso: since.toISOString(),
            limit: 5,
            domain: "work",
            ...projectFilter,
            ...workspaceFilter,
          })
          .catch(() => []),
        ctx.engram
          .search({
            query: "recent activity",
            sinceIso: since.toISOString(),
            limit: 20,
            domain: "work",
            ...projectFilter,
            ...workspaceFilter,
          })
          .catch(() => []),
        input.includeUnclassified
          ? ctx.engram
              .search({
                query: "unclassified",
                sinceIso: new Date(
                  since.getTime() - 14 * 86_400_000,
                ).toISOString(),
                limit: 50,
                domain: "work",
                ...projectFilter,
                ...workspaceFilter,
              })
              .catch(() => [])
          : Promise.resolve([]),
      ]);

    const upcomingEvents = upcoming
      .map(toEvent)
      .filter((e): e is DigestEvent => Boolean(e))
      .filter((e) => {
        if (!e.start) return false;
        const t = Date.parse(e.start);
        return t >= now.getTime() && t <= upcomingTo.getTime();
      })
      .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""))
      .slice(0, 10);

    const openActions: DigestAction[] = [];
    const overdueActions: DigestAction[] = [];
    const todayIso = now.toISOString().slice(0, 10);

    for (const mem of actionMems) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      if (tags.includes("status:done") || tags.includes("status:dropped")) {
        continue;
      }
      const assignee = tags
        .find((t) => t.startsWith("owner:"))
        ?.slice("owner:".length);
      if (assigneeSlug && assignee && assignee !== assigneeSlug) continue;

      const due = tags
        .find((t) => t.startsWith("due:"))
        ?.slice("due:".length);
      const action: DigestAction = {
        content: mem.content,
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        ...(assignee ? { assignee } : {}),
        ...(due ? { due } : {}),
      };
      if (due && due < todayIso) overdueActions.push(action);
      else openActions.push(action);
    }

    openActions.sort(sortByDue);
    overdueActions.sort(sortByDue);

    const decisions = recentDecisions.slice(0, 5).map(toRecentRow);
    const briefs = recentBriefs.slice(0, 5).map(toRecentRow);
    const otherSeen = new Set<string>(
      [...recentDecisions, ...recentBriefs].map((m) => m.id),
    );
    const other = recentOther
      .filter((m) => !otherSeen.has(m.id))
      .slice(0, 8)
      .map(toRecentRow)
      .filter((r) => r.type !== "decision" && r.type !== "brief");

    const unclassifiedCount = unclassified.filter((mem) => {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const conf = typeof meta.confidence === "number" ? meta.confidence : 0;
      const projects = normalizeProjects(meta.project);
      return projects.length === 0 || conf <= 0.5;
    }).length;

    return {
      generatedAt: now.toISOString(),
      window: {
        since: since.toISOString(),
        until: upcomingTo.toISOString(),
      },
      upcoming: upcomingEvents,
      openActionItems: openActions.slice(0, 20),
      overdueActionItems: overdueActions.slice(0, 20),
      recent: { decisions, briefs, other },
      ...(input.includeUnclassified
        ? { unclassifiedQueueSize: unclassifiedCount }
        : {}),
      summary: {
        upcomingCount: upcomingEvents.length,
        actionItemsOpen: openActions.length,
        actionItemsOverdue: overdueActions.length,
        recentDecisions: decisions.length,
        recentBriefs: briefs.length,
      },
    };
  },
};

function toEvent(
  mem: { id: string; content: string; metadata?: Record<string, unknown> },
): DigestEvent | null {
  const meta = (mem.metadata ?? {}) as Record<string, unknown>;
  const start = meta.start ?? meta.date;
  const startIso =
    typeof start === "string" && !Number.isNaN(Date.parse(start))
      ? start
      : undefined;
  return {
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    ...(startIso ? { start: startIso } : {}),
    ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
    ...(typeof meta.project === "string" ? { project: meta.project } : {}),
  };
}

function toRecentRow(mem: {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  type?: string;
}): DigestRecent {
  const meta = (mem.metadata ?? {}) as Record<string, unknown>;
  return {
    type: (meta.type as string | undefined) ?? mem.type ?? "unknown",
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    preview: mem.content.slice(0, 240),
    ...(typeof meta.date === "string" ? { date: meta.date } : {}),
    ...(typeof meta.source === "string" ? { source: meta.source } : {}),
  };
}

function sortByDue(a: DigestAction, b: DigestAction): number {
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  if (a.due && b.due) return a.due.localeCompare(b.due);
  return 0;
}

function normalizeProjects(raw: unknown): string[] {
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw)) {
    return raw.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  }
  return [];
}
