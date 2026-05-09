import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Result count. Default 10, cap 50. */
  topK: z.number().int().positive().max(50).default(10),
  /** Lookback window in days. Default 7. */
  days: z.number().int().positive().max(365).default(7),
  /**
   * Optional content-type filter. Mirrors the kb_search enum so
   * callers can ask "what docs did we add this week" vs "what code
   * landed."
   */
  type: z
    .enum([
      "meeting", "decision", "action_item", "doc", "code", "note",
      "brief", "digest", "conversation", "commit", "event", "reference",
      "session_handoff",
    ])
    .optional(),
});

interface RecentRow {
  id: string;
  title?: string;
  snippet: string;
  type?: string;
  source?: string;
  source_url?: string;
  date?: string;
  project?: string | string[];
}

interface Output {
  count: number;
  since: string;
  results: RecentRow[];
}

/**
 * Newest-ingested chunks in the workspace.
 *
 * Different query pattern than kb_search — search is relevance-ranked
 * to a query; this is just "what landed recently?" Backed by the same
 * engram surface as search-related but with no query (passes a
 * single-character query and lets the date filter + sort do the work).
 *
 * The Pyre Knowledge card uses this for the "Recent Ingests" pane —
 * the user can see what their last ingest_file / inbox-watcher run
 * actually produced without having to remember a search term.
 */
export const kbRecent: McpTool<typeof inputSchema, Output> = {
  name: "kb_recent",
  description:
    "Newest-ingested chunks in the current session workspace. Different " +
    "from kb_search (relevance-ranked) — this is 'what landed recently' " +
    "ordered by ingestion date. Filter by type to scope to docs / code / " +
    "decisions / etc. Use to give the user a 'what's in my KB right now' " +
    "view without needing a query term.",
  inputSchema,

  async handler(input, ctx) {
    const sinceDate = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
    const sinceIso = sinceDate.toISOString();
    // engram's search interface doesn't support an empty query in
    // every version — pass a single-char wildcard-equivalent that the
    // hybrid retrieval treats as "anything." The since/limit filters
    // do the real work.
    const rows = await ctx.engram.search({
      query: " ",
      limit: input.topK,
      domain: "work",
      sinceIso,
      ...(input.type ? { type: input.type } : {}),
      ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
    });

    const results: RecentRow[] = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const snippet = row.content.length > 260
        ? `${row.content.slice(0, 260)}…`
        : row.content;
      const result: RecentRow = { id: row.id, snippet };
      if (typeof meta.title === "string") result.title = meta.title;
      if (typeof meta.type === "string") result.type = meta.type;
      if (typeof meta.source === "string") result.source = meta.source;
      if (typeof meta.source_url === "string") result.source_url = meta.source_url;
      if (typeof meta.date === "string") result.date = meta.date;
      else if (row.createdAt) result.date = row.createdAt;
      const project = meta.project;
      if (typeof project === "string" || Array.isArray(project)) {
        result.project = project as string | string[];
      }
      return result;
    });

    // Engram's underlying search is relevance-ranked even with a
    // wildcard query; sort by date desc here so the freshness story
    // is honest.
    results.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

    return {
      count: results.length,
      since: sinceIso,
      results,
    };
  },
};
