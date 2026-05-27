import { z } from "zod";
import type { McpTool } from "../tool.js";
import { searchRelated } from "./search-related.js";

const inputSchema = z.object({
  /** Free-text query. Hybrid semantic + keyword via Engram. */
  query: z.string().min(1),
  /** Optional project filter (project slug or alias). */
  project: z.string().optional(),
  /**
   * Optional content-type filter. Mirrors the search_related enum.
   * `meeting` and `decision` are useful for "what did we decide" flows;
   * `doc` / `code` for reference material.
   */
  type: z
    .enum([
      "meeting", "decision", "action_item", "doc", "code", "note",
      "brief", "digest", "conversation", "commit", "event", "reference",
      "session_handoff",
    ])
    .optional(),
  /** Optional source filter (github, confluence, jira, slack, etc.). */
  source: z
    .enum([
      "loom", "google_meet", "confluence", "notion", "google_drive",
      "jira", "linear", "bitbucket", "github", "calendar", "slack",
      "teams", "email", "obsidian", "manual",
    ])
    .optional(),
  /** ISO 8601 lower bound. */
  since: z.string().datetime().optional(),
  /** Result count. Default 10, cap 50. */
  topK: z.number().int().positive().max(50).default(10),
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
   * Omit to use the default soft down-ranking behavior where `experimental`
   * and `external` rows remain visible but rank slightly lower than
   * `approved` rows. Ordering: external < experimental < approved.
   */
  minTrust: z.enum(["external", "experimental", "approved"]).optional(),
});

/**
 * Knowledge-base search.
 *
 * Phase 4 retrieval surface for the knowledge-engine repositioning.
 * Pyre's coordinator calls `kb_search` (org KB) alongside Engram's
 * `memory_search` (per-user memory) to compose two cognitive layers
 * cleanly.
 *
 * Implementation: thin wrapper around `search_related`. We preserve
 * `search_related` for back-compat with any existing consumer; new
 * clients should prefer `kb_search` for the clearer naming.
 */
export const kbSearch: McpTool<typeof inputSchema, ReturnType<typeof searchRelated.handler> extends Promise<infer R> ? R : never> = {
  name: "kb_search",
  description:
    "Search the multi-tenant knowledge base (Cortex). Hybrid semantic " +
    "+ keyword retrieval scoped to the session's workspace. Filter by " +
    "project / type / source / since. Compose with Pyre's memory_search " +
    "(per-user memory) to cover both 'what does the org know about X' " +
    "and 'what does the user know about X' in one turn. Returns compact " +
    "results (snippet + metadata) — use kb_dossier for structured pre-load " +
    "of an entity (project, person), or read full content via the " +
    "search-related path when needed.",
  inputSchema,

  async handler(input, ctx) {
    // Map kb_search's `topK` field to search_related's `limit` and
    // delegate. Field renames only; semantics identical.
    return searchRelated.handler(
      {
        query: input.query,
        limit: input.topK,
        ...(input.project ? { project: input.project } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.maxSensitivity
          ? { maxSensitivity: input.maxSensitivity }
          : {}),
        ...(input.minTrust ? { minTrust: input.minTrust } : {}),
      },
      ctx,
    );
  },
};
