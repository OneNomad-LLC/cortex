import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Free-text query. Uses engram's hybrid semantic + keyword search. */
  query: z.string().min(1),
  /** Project slug filter — typically the project a PR or ticket belongs to. */
  project: z.string().optional(),
  /**
   * Content-type filter. Meeting/decision are useful for "what did we
   * decide about X last quarter" flows; doc for reference material.
   */
  type: z
    .enum([
      "meeting",
      "decision",
      "action_item",
      "doc",
      "code",
      "note",
      "brief",
      "digest",
      "conversation",
      "commit",
      "event",
      "reference",
      "session_handoff",
    ])
    .optional(),
  /** Source filter (github, confluence, slack, etc.). */
  source: z
    .enum([
      "loom",
      "google_meet",
      "confluence",
      "notion",
      "google_drive",
      "jira",
      "linear",
      "bitbucket",
      "github",
      "calendar",
      "slack",
      "teams",
      "email",
      "obsidian",
      "manual",
    ])
    .optional(),
  /** ISO 8601 lower bound — "things since the last release" etc. */
  since: z.string().datetime().optional(),
  /** Max results. Default 10, cap 50. */
  limit: z.number().int().positive().max(50).default(10),
  /**
   * Exclude rows whose sensitivity exceeds this level. Omit to return all
   * sensitivity levels (default behavior — no filter applied).
   * Ordering: public < internal < confidential < restricted.
   */
  maxSensitivity: z
    .enum(["public", "internal", "confidential", "restricted"])
    .optional(),
  /**
   * Strict trust filter. When set, rows below this trust level are excluded.
   * Omit to use soft down-ranking of `experimental` and `external` rows.
   * Ordering: external < experimental < approved.
   */
  minTrust: z.enum(["external", "experimental", "approved"]).optional(),
});

interface Output {
  query: string;
  count: number;
  results: Array<{
    id: string;
    title?: string;
    snippet: string;
    score?: number;
    type?: string;
    source?: string;
    project?: string | string[];
    source_url?: string;
    date?: string;
    people?: string[];
    due_date?: string;
    urgency?: string;
    mentions_me?: boolean;
  }>;
}

/**
 * Semantic-first retrieval with convenient filters. Lighter than
 * summarize_recent or get_project_context — intended for "give me the
 * 10 most relevant past decisions about X so I can weigh in on
 * this PR" or "what did we say about auth migration last quarter"
 * flows. Claude should call this before committing to a
 * recommendation on anything the user shares (PR, ticket, draft).
 */
export const searchRelated: McpTool<typeof inputSchema, Output> = {
  name: "search_related",
  description:
    "Retrieve memories most relevant to a query, scoped by project, " +
    "type, source, and/or time. Primary use: gather historical " +
    "context before giving a recommendation. Example calls: " +
    "{ query: 'auth migration tradeoffs', project: 'alpha', " +
    "type: 'decision' }. Returns compact results (snippet + " +
    "metadata) — use get_project_context or direct memory reads " +
    "when you need full content.",
  inputSchema,

  async handler(input, ctx) {
    const rows = await ctx.engram.search({
      query: input.query,
      limit: input.limit,
      domain: "work",
      ...(input.project ? { project: input.project } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.since ? { sinceIso: input.since } : {}),
      // Scope results to the session's workspace. When the session is
      // in no-workspace mode (sessionWorkspace === null), omit the
      // filter so results from any workspace are returned.
      ...(ctx.sessionWorkspace
        ? { workspace: ctx.sessionWorkspace }
        : {}),
      ...(input.maxSensitivity
        ? { maxSensitivity: input.maxSensitivity }
        : {}),
      ...(input.minTrust ? { minTrust: input.minTrust } : {}),
    });

    const results = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const snippet =
        row.content.length > 260
          ? `${row.content.slice(0, 260)}…`
          : row.content;
      const result: Output["results"][number] = {
        id: row.id,
        snippet,
      };
      if (typeof row.score === "number") result.score = row.score;
      if (typeof meta.title === "string") result.title = meta.title;
      if (typeof meta.type === "string") result.type = meta.type;
      if (typeof meta.source === "string") result.source = meta.source;
      const project = meta.project;
      if (typeof project === "string" || Array.isArray(project)) {
        result.project = project as string | string[];
      }
      if (typeof meta.source_url === "string")
        result.source_url = meta.source_url;
      if (typeof meta.date === "string") result.date = meta.date;
      if (Array.isArray(meta.people))
        result.people = (meta.people as unknown[]).filter(
          (p): p is string => typeof p === "string",
        );
      if (typeof meta.due_date === "string") result.due_date = meta.due_date;
      if (typeof meta.urgency === "string") result.urgency = meta.urgency;
      if (typeof meta.mentions_me === "boolean")
        result.mentions_me = meta.mentions_me;
      return result;
    });

    return {
      query: input.query,
      count: results.length,
      results,
    };
  },
};
