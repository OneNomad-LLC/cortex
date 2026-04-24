import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Owner slug / name / email for action items. Empty = everyone. */
  owner: z.string().default(""),
  /** Hours of upcoming events to include. */
  upcomingHours: z.number().int().min(0).max(168).default(24),
  /** Hours of recent activity to include. */
  lookbackHours: z.number().int().min(1).max(168).default(24),
  /** Include classifier review-queue count in the summary. */
  includeUnclassified: z.boolean().default(true),
});

interface DigestAction {
  content: string;
  owner?: string;
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
  window: { recentSince: string; upcomingTo: string };
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

export const todaysDigest: McpTool<typeof inputSchema, Output> = {
  name: "todays_digest",
  description:
    "One-glance digest of today's work state: events coming up next " +
    "N hours, open action items (with overdue highlighted), recent " +
    "decisions / briefs, and unclassified-queue size. The morning-" +
    "coffee tool — run once to orient, then dig into specific tools.",
  inputSchema,

  async handler(input, ctx) {
    const now = new Date();
    const recentSince = new Date(
      now.getTime() - input.lookbackHours * 3_600_000,
    );
    const upcomingTo = new Date(
      now.getTime() + input.upcomingHours * 3_600_000,
    );

    let ownerSlug: string | undefined;
    if (input.owner.trim()) {
      const person = ctx.taxonomy.findPerson(input.owner);
      ownerSlug = person?.slug ?? input.owner;
    }

    const workspaceFilter = ctx.sessionWorkspace
      ? { workspace: ctx.sessionWorkspace }
      : {};

    const [upcoming, actionMems, recentDecisions, recentBriefs, recentOther, unclassified] =
      await Promise.all([
        input.upcomingHours > 0
          ? ctx.engram
              .search({
                query: "upcoming calendar event",
                type: "event",
                sinceIso: now.toISOString(),
                limit: 10,
                domain: "work",
                ...workspaceFilter,
              })
              .catch(() => [])
          : Promise.resolve([]),
        ctx.engram
          .search({
            query: ownerSlug ? `action_item owner:${ownerSlug}` : "action_item",
            type: "action_item",
            sinceIso: new Date(now.getTime() - 60 * 86_400_000).toISOString(),
            limit: 60,
            domain: "work",
            ...workspaceFilter,
          })
          .catch(() => []),
        ctx.engram
          .search({
            query: "decision",
            type: "decision",
            sinceIso: recentSince.toISOString(),
            limit: 5,
            domain: "work",
            ...workspaceFilter,
          })
          .catch(() => []),
        ctx.engram
          .search({
            query: "brief",
            type: "brief",
            sinceIso: recentSince.toISOString(),
            limit: 5,
            domain: "work",
            ...workspaceFilter,
          })
          .catch(() => []),
        ctx.engram
          .search({
            query: "recent activity",
            sinceIso: recentSince.toISOString(),
            limit: 20,
            domain: "work",
            ...workspaceFilter,
          })
          .catch(() => []),
        input.includeUnclassified
          ? ctx.engram
              .search({
                query: "unclassified",
                sinceIso: new Date(now.getTime() - 14 * 86_400_000).toISOString(),
                limit: 50,
                domain: "work",
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
      .sort((a, b) =>
        (a.start ?? "").localeCompare(b.start ?? ""),
      )
      .slice(0, 10);

    const openActions: DigestAction[] = [];
    const overdueActions: DigestAction[] = [];
    const todayIso = now.toISOString().slice(0, 10);

    for (const mem of actionMems) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      if (
        tags.includes("status:done") ||
        tags.includes("status:dropped")
      ) {
        continue;
      }
      const owner = tags
        .find((t) => t.startsWith("owner:"))
        ?.slice("owner:".length);
      if (ownerSlug && owner && owner !== ownerSlug) continue;

      const due = tags
        .find((t) => t.startsWith("due:"))
        ?.slice("due:".length);
      const action: DigestAction = {
        content: mem.content,
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        ...(owner ? { owner } : {}),
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
      const conf =
        typeof meta.confidence === "number" ? meta.confidence : 0;
      const projects = normalizeProjects(meta.project);
      return projects.length === 0 || conf <= 0.5;
    }).length;

    return {
      generatedAt: now.toISOString(),
      window: {
        recentSince: recentSince.toISOString(),
        upcomingTo: upcomingTo.toISOString(),
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
    return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  return [];
}
