import { z } from "zod";
import type { EngramClient, EngramMemory } from "../../clients/engram.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Hours to look ahead. Default 24 = rest of today + tomorrow morning. */
  hoursAhead: z.number().int().min(1).max(168).default(24),
  /** Minutes before the event to generate briefs for (0 = all upcoming in window). */
  minutesThreshold: z.number().int().min(0).max(1440).default(0),
  /** Max number of events to brief. */
  limit: z.number().int().min(1).max(20).default(5),
  /** When false, skip the LLM synthesis pass and return only the context payload. */
  generateBrief: z.boolean().default(true),
  /** Optional project slug to scope the briefs. */
  project: z.string().default(""),
});

interface EventBrief {
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  url?: string;
  projectSlug?: string;
  brief?: string;
  context: {
    recent_meetings: Array<{ title?: string; date?: string; preview: string }>;
    open_action_items: Array<{ content: string; owner?: string; due?: string }>;
    relevant_docs: Array<{ title?: string; preview: string; url?: string }>;
    recent_decisions: Array<{ content: string; owner?: string }>;
  };
}

interface Output {
  now: string;
  window: { from: string; to: string };
  events: EventBrief[];
  hint?: string;
}

export const upcomingBriefs: McpTool<typeof inputSchema, Output> = {
  name: "upcoming_briefs",
  description:
    "Generate pre-meeting briefs for events in the next N hours. For " +
    "each calendar event, pulls related project context (recent " +
    "meetings, decisions, open action items, relevant docs) from Engram " +
    "and synthesizes a short markdown brief. Optional per-event trigger " +
    "(minutesThreshold) so you can get a nudge 30 min before each meeting.",
  inputSchema,

  async handler(input, ctx) {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + input.hoursAhead * 3_600_000);

    let projectSlug: string | undefined;
    if (input.project.trim()) {
      const project = ctx.taxonomy.findProject(input.project);
      if (!project) {
        return {
          now: now.toISOString(),
          window: { from: now.toISOString(), to: windowEnd.toISOString() },
          events: [],
          hint: `No project matched '${input.project}'.`,
        };
      }
      projectSlug = project.slug;
    }

    const events = await ctx.engram
      .search({
        query: "calendar event",
        type: "event",
        ...(projectSlug ? { project: projectSlug } : {}),
        sinceIso: now.toISOString(),
        limit: input.limit * 3,
        domain: "work",
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
        if (input.minutesThreshold === 0) return true;
        return diffMs <= input.minutesThreshold * 60_000;
      })
      .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0))
      .slice(0, input.limit);

    const results: EventBrief[] = [];
    for (const { memory, start } of inWindow) {
      const meta = (memory.metadata ?? {}) as Record<string, unknown>;
      const eventProject = pickProject(meta);
      const context = await gatherContext({
        engram: ctx.engram,
        projectSlug: eventProject,
        since: new Date(now.getTime() - 30 * 86_400_000),
      });

      const peopleRaw = memory.metadata?.people;
      const attendees = Array.isArray(peopleRaw) ? (peopleRaw as string[]) : [];

      const eventBrief: EventBrief = {
        eventId: memory.id,
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        ...(start ? { start: start.toISOString() } : {}),
        ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
        ...(eventProject ? { projectSlug: eventProject } : {}),
        attendees,
        context,
      };

      if (input.generateBrief && ctx.llmRouter) {
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
        }).catch((err) => {
          ctx.logger.warn("upcoming_briefs.brief_llm_failed", {
            eventId: memory.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        });
        if (briefText) eventBrief.brief = briefText;
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

function eventStart(memory: EngramMemory): Date | undefined {
  const meta = (memory.metadata ?? {}) as Record<string, unknown>;
  const start = meta.start ?? meta.date;
  if (typeof start === "string") {
    const d = new Date(start);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function pickProject(
  meta: Record<string, unknown>,
): string | undefined {
  const p = meta.project;
  if (typeof p === "string" && p.length > 0) return p;
  if (Array.isArray(p) && p.length > 0 && typeof p[0] === "string") {
    return p[0] as string;
  }
  return undefined;
}

async function gatherContext(args: {
  engram: EngramClient;
  projectSlug: string | undefined;
  since: Date;
}): Promise<EventBrief["context"]> {
  const sinceIso = args.since.toISOString();
  const common = {
    sinceIso,
    domain: "work",
    ...(args.projectSlug ? { project: args.projectSlug } : {}),
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
  llmRouter: NonNullable<ReturnType<() => import("@onenomad/cortex-llm-core").LLMRouter>>;
  event: {
    title: string;
    start: string;
    attendees: string[];
    description: string;
  };
  projectSlug: string | undefined;
  context: EventBrief["context"];
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
