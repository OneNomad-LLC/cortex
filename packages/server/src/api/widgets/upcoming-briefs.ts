import type { EngramClient, EngramMemory } from "../../clients/engram.js";
import type { Widget, WidgetContext } from "../types.js";

/**
 * Dashboard "upcoming briefs" widget — surfaces meetings in the next
 * N hours with a context payload (recent activity per project, open
 * action items, decisions). Optional LLM-rendered brief per event
 * when `generateBrief=true` AND a local LLM is configured.
 *
 * Cortex 0.2 — the MCP `upcoming_briefs` tool was removed (it was
 * personal-assistant scope). The dashboard widget is preserved as a
 * UX surface, so the logic that lived in the tool is inlined here.
 */
export const upcomingBriefsWidget: Widget = {
  name: "upcoming-briefs",
  description:
    "Upcoming meetings with a context payload (attendees, decisions, open action items). Optional LLM-generated brief per event.",

  async handler(query, ctx) {
    const hoursAhead = clampInt(query.get("hoursAhead"), 1, 168, 24);
    const minutesThreshold = clampInt(
      query.get("minutesThreshold"),
      0,
      1440,
      0,
    );
    const limit = clampInt(query.get("limit"), 1, 20, 5);
    const project = (query.get("project") ?? "").trim();
    const generateBrief =
      (query.get("generateBrief") ?? "").toLowerCase() === "true";

    const now = new Date();
    const windowEnd = new Date(now.getTime() + hoursAhead * 3_600_000);

    let projectSlug: string | undefined;
    if (project) {
      const p = ctx.taxonomy.findProject(project);
      if (!p) {
        return {
          now: now.toISOString(),
          window: { from: now.toISOString(), to: windowEnd.toISOString() },
          events: [],
          hint: `No project matched '${project}'.`,
        };
      }
      projectSlug = p.slug;
    }

    const workspaceFilter = ctx.workspace?.slug
      ? { workspace: ctx.workspace.slug }
      : {};

    const events = await ctx.engram
      .search({
        query: "calendar event",
        type: "event",
        ...(projectSlug ? { project: projectSlug } : {}),
        sinceIso: now.toISOString(),
        limit: limit * 3,
        domain: "work",
        ...workspaceFilter,
      })
      .catch((err) => {
        ctx.logger.warn("upcoming_briefs.events_fetch_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

    const inWindow = events
      .map((m) => ({ memory: m, start: eventStart(m) }))
      .filter((r) => {
        if (!r.start) return false;
        const diffMs = r.start.getTime() - now.getTime();
        if (diffMs < 0 || r.start > windowEnd) return false;
        if (minutesThreshold === 0) return true;
        return diffMs <= minutesThreshold * 60_000;
      })
      .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0))
      .slice(0, limit);

    const results: Array<{
      eventId: string;
      title?: string;
      start?: string;
      attendees: string[];
      url?: string;
      projectSlug?: string;
      brief?: string;
      context: ReturnType<typeof emptyContext>;
    }> = [];

    for (const { memory, start } of inWindow) {
      const meta = (memory.metadata ?? {}) as Record<string, unknown>;
      const eventProject = pickProject(meta);
      const context = await gatherContext({
        engram: ctx.engram,
        projectSlug: eventProject,
        since: new Date(now.getTime() - 30 * 86_400_000),
        sessionWorkspace: ctx.workspace?.slug,
      });

      const peopleRaw = memory.metadata?.people;
      const attendees = Array.isArray(peopleRaw) ? (peopleRaw as string[]) : [];

      const eventBrief = {
        eventId: memory.id,
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        ...(start ? { start: start.toISOString() } : {}),
        ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
        ...(eventProject ? { projectSlug: eventProject } : {}),
        attendees,
        context,
      } as (typeof results)[number];

      // Cortex 0.2 — only render the LLM-backed brief when both the
      // caller asks for it AND a local LLM is available. Without an
      // LLM the widget still returns the structured context block
      // so the dashboard can render the "context-only" view.
      if (generateBrief && ctx.llmRouter) {
        try {
          const briefText = await generateBriefText({
            llmRouter: ctx.llmRouter,
            event: {
              title: eventBrief.title ?? "Untitled event",
              start: eventBrief.start ?? "",
              attendees,
              description: memory.content,
            },
            projectSlug: eventProject,
            context,
          });
          if (briefText) eventBrief.brief = briefText;
        } catch (err) {
          ctx.logger.warn("upcoming_briefs.brief_llm_failed", {
            eventId: memory.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      results.push(eventBrief);
    }

    return {
      now: now.toISOString(),
      window: { from: now.toISOString(), to: windowEnd.toISOString() },
      events: results,
    };
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

function eventStart(memory: EngramMemory): Date | undefined {
  const meta = (memory.metadata ?? {}) as Record<string, unknown>;
  const start = meta.start ?? meta.date;
  if (typeof start === "string") {
    const d = new Date(start);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function pickProject(meta: Record<string, unknown>): string | undefined {
  const p = meta.project;
  if (typeof p === "string" && p.length > 0) return p;
  if (Array.isArray(p) && p.length > 0 && typeof p[0] === "string") {
    return p[0] as string;
  }
  return undefined;
}

function emptyContext(): {
  recent_meetings: Array<{ title?: string; date?: string; preview: string }>;
  open_action_items: Array<{ content: string; owner?: string; due?: string }>;
  relevant_docs: Array<{ title?: string; preview: string; url?: string }>;
  recent_decisions: Array<{ content: string; owner?: string }>;
} {
  return {
    recent_meetings: [],
    open_action_items: [],
    relevant_docs: [],
    recent_decisions: [],
  };
}

async function gatherContext(args: {
  engram: EngramClient;
  projectSlug: string | undefined;
  since: Date;
  sessionWorkspace: string | null | undefined;
}): Promise<ReturnType<typeof emptyContext>> {
  const sinceIso = args.since.toISOString();
  const common = {
    sinceIso,
    domain: "work",
    ...(args.projectSlug ? { project: args.projectSlug } : {}),
    ...(args.sessionWorkspace ? { workspace: args.sessionWorkspace } : {}),
  };

  const [meetings, actionItems, docs, decisions] = await Promise.all([
    args.engram
      .search({ query: "meeting brief", type: "brief", limit: 3, ...common })
      .catch(() => []),
    args.engram
      .search({
        query: "action_item",
        type: "action_item",
        limit: 10,
        ...common,
      })
      .catch(() => []),
    args.engram
      .search({ query: "relevant doc", type: "doc", limit: 3, ...common })
      .catch(() => []),
    args.engram
      .search({
        query: "decision",
        type: "decision",
        limit: 5,
        ...common,
      })
      .catch(() => []),
  ]);

  return {
    recent_meetings: meetings.map((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      return {
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        ...(typeof meta.date === "string" ? { date: meta.date } : {}),
        preview: m.content.slice(0, 300),
      };
    }),
    open_action_items: actionItems
      .filter((m) => {
        const tags = ((m.metadata ?? {}) as { tags?: string[] }).tags ?? [];
        return !tags.includes("status:done") && !tags.includes("status:dropped");
      })
      .slice(0, 8)
      .map((m) => {
        const tags = ((m.metadata ?? {}) as { tags?: string[] }).tags ?? [];
        const owner = tags.find((t) => t.startsWith("owner:"))?.slice(6);
        const due = tags.find((t) => t.startsWith("due:"))?.slice(4);
        return {
          content: m.content,
          ...(owner ? { owner } : {}),
          ...(due ? { due } : {}),
        };
      }),
    relevant_docs: docs.map((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      return {
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        preview: m.content.slice(0, 300),
        ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
      };
    }),
    recent_decisions: decisions.map((m) => {
      const tags = ((m.metadata ?? {}) as { tags?: string[] }).tags ?? [];
      const owner = tags.find((t) => t.startsWith("owner:"))?.slice(6);
      return { content: m.content, ...(owner ? { owner } : {}) };
    }),
  };
}

async function generateBriefText(args: {
  llmRouter: NonNullable<WidgetContext["llmRouter"]>;
  event: {
    title: string;
    start: string;
    attendees: string[];
    description: string;
  };
  projectSlug: string | undefined;
  context: ReturnType<typeof emptyContext>;
}): Promise<string> {
  const prompt = [
    "Write a concise pre-meeting brief in markdown. Optimize for an ADHD reader:",
    "front-load the action items and questions, keep sentences short, use headings.",
    "",
    "Structure:",
    "```",
    "# <event title>",
    "_<local time> · <attendees>_",
    "",
    "## Why this meeting",
    "(1-2 bullets. Based on description + recent activity. If genuinely unclear, say so.)",
    "",
    "## Open threads to resolve",
    "(Bulleted. The action items, unresolved decisions, open questions.)",
    "",
    "## Suggested questions",
    "(3-5 bullets. Things the reader should raise based on context.)",
    "",
    "## Relevant context",
    "(1-3 bullets. Brief citations of relevant meetings / docs / decisions.)",
    "```",
    "",
    "Rules:",
    "- Never invent action items that aren't in the context.",
    "- Skip any section that has nothing to show.",
    "- If open_action_items is empty, omit that section.",
    "",
    `EVENT: ${args.event.title} @ ${args.event.start}`,
    `ATTENDEES: ${args.event.attendees.join(", ") || "unknown"}`,
    `PROJECT: ${args.projectSlug ?? "unscoped"}`,
    "",
    "DESCRIPTION:",
    args.event.description.slice(0, 1500),
    "",
    "CONTEXT (JSON):",
    JSON.stringify(args.context, null, 2).slice(0, 5000),
  ].join("\n");

  const response = await args.llmRouter.complete({
    task: "brief",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    maxTokens: 1024,
  });
  return response.content.trim();
}
