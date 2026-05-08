import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** The id from the corresponding `pending_enrichment_requests` poll. */
  id: z.string().min(1),
  /**
   * The enrichment result. Shape varies by request type — see
   * `docs/enrichment-protocol.md` for the per-type schemas:
   *   - categorize:       `{ category, confidence, tags[] }`
   *   - extract_actions:  `{ actions[] }`
   *   - summarize:        `{ summary, key_points[] }`
   *   - tag_entities:     `{ entities[] }`
   * Pass `error` instead when the provider couldn't produce a result.
   */
  result: z.unknown().optional(),
  /** Set when the provider couldn't produce a usable result. */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

interface Output {
  accepted: boolean;
  /**
   * "no_queue" → Cortex isn't running in queue mode (has a local LLM).
   * "unknown_id" → request expired or was never queued.
   * "ok" → result delivered to the waiting pipeline.
   */
  reason: "ok" | "no_queue" | "unknown_id";
}

/**
 * Counterpart to `pending_enrichment_requests`. Connected MCP
 * clients post enrichment results back to Cortex with this tool.
 * Cortex hands the result to the waiting pipeline so ingestion can
 * proceed with structured metadata.
 *
 * Part of Cortex Enrichment Protocol v1.
 */
export const submitEnrichmentResult: McpTool<typeof inputSchema, Output> = {
  name: "submit_enrichment_result",
  description:
    "Post an enrichment result back to Cortex. The `id` must match a " +
    "request previously returned by `pending_enrichment_requests`. " +
    "Send `result` for a successful enrichment, `error` for a " +
    "failure. Cortex passes the result to the waiting pipeline so " +
    "ingestion can resume with the enriched metadata.",
  inputSchema,

  async handler(input, ctx) {
    const queue = ctx.enrichmentQueue;
    if (!queue) {
      return { accepted: false, reason: "no_queue" };
    }
    if (!input.result && !input.error) {
      return { accepted: false, reason: "unknown_id" };
    }
    const payload = input.error
      ? { error: input.error }
      : (input.result as never);
    const ok = queue.submit(input.id, payload);
    return ok
      ? { accepted: true, reason: "ok" }
      : { accepted: false, reason: "unknown_id" };
  },
};
