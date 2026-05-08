import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Max requests to return in this poll. */
  limit: z.number().int().min(1).max(100).default(25),
});

interface Output {
  /** Generated when this poll is served — clients track their own clock. */
  polledAt: string;
  /** Number of pending requests still in the queue after this poll. */
  remaining: number;
  /** Whether Cortex has an enrichment queue at all (false = local LLM mode). */
  enabled: boolean;
  requests: Array<{
    id: string;
    enqueuedAt: string;
    type: string;
    payload: Record<string, unknown>;
    context?: Record<string, unknown>;
  }>;
}

/**
 * Connected MCP clients (Pyre, Claude Desktop) call this tool to
 * pull pending enrichment requests. They process each request with
 * their own LLM and post results back via `submit_enrichment_result`.
 *
 * Part of Cortex Enrichment Protocol v1. See
 * `docs/enrichment-protocol.md`.
 */
export const pendingEnrichmentRequests: McpTool<typeof inputSchema, Output> = {
  name: "pending_enrichment_requests",
  description:
    "Drain pending enrichment requests from Cortex's queue. Connected " +
    "MCP clients call this when they have spare capacity, process the " +
    "requests with their own LLM, then post results back via " +
    "`submit_enrichment_result`. Returns an empty list when Cortex is " +
    "running in local-LLM mode (no queue) or no work is pending.",
  inputSchema,

  async handler(input, ctx) {
    const queue = ctx.enrichmentQueue;
    if (!queue) {
      return {
        polledAt: new Date().toISOString(),
        remaining: 0,
        enabled: false,
        requests: [],
      };
    }
    const drained = queue.drain(input.limit);
    return {
      polledAt: new Date().toISOString(),
      remaining: queue.size(),
      enabled: true,
      requests: drained.map((q) => ({
        id: q.id,
        enqueuedAt: q.enqueuedAt,
        type: q.request.type,
        payload: q.request.payload,
        ...(q.request.context ? { context: q.request.context } : {}),
      })),
    };
  },
};
