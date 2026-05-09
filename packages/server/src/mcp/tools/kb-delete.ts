import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * Stable source_id of the chunk to remove. Same value Cortex's ingest
   * tools used as the dedup key — for ingest_file this is the absolute
   * file path; for ingest_url, the URL; for ingest_repo, the per-file
   * absolute path; for ingest_content, whatever the caller passed.
   * Use kb_search first to find the source_id of an unwanted chunk.
   */
  sourceId: z.string().min(1).optional(),
  /**
   * Backend-assigned uuid of the chunk. Returned by kb_search as the
   * `id` field on each result row. Use when sourceId isn't known.
   * Exactly one of sourceId / id must be provided.
   */
  id: z.string().min(1).optional(),
}).refine((v) => Boolean(v.sourceId) !== Boolean(v.id), {
  message: "exactly one of sourceId / id must be provided",
});

interface Output {
  /** True when the underlying delete call succeeded (even if 0 rows). */
  ok: boolean;
  /** Number of chunks removed. 0 = nothing matched, treated as success. */
  deleted: number;
  /** Reason when ok=false (e.g. engram doesn't expose delete on this release). */
  reason?: string;
}

/**
 * Remove a chunk from the knowledge base.
 *
 * Round-trips to engram's memory_delete via the optional `delete()`
 * method on EngramAccess. Older engram releases that don't expose
 * delete return ok:false with a clear reason — the renderer should
 * surface this as "your engram backend is too old" rather than
 * pretending the delete worked.
 *
 * The Pyre Knowledge card uses this for the per-result delete affordance
 * in the search results pane: search → find an unwanted chunk →
 * one-click remove → re-search to confirm.
 */
export const kbDelete: McpTool<typeof inputSchema, Output> = {
  name: "kb_delete",
  description:
    "Remove a chunk from the knowledge base by sourceId (preferred — " +
    "matches the dedup key the ingest tools used) or by backend uuid " +
    "(returned as `id` from kb_search). Exactly one of the two is " +
    "required. Returns deleted=N (0 when nothing matched, treated as " +
    "success). Requires an engram release that exposes memory_delete; " +
    "older releases return ok:false with a reason.",
  inputSchema,

  async handler(input, ctx) {
    if (typeof ctx.engram.delete !== "function") {
      return {
        ok: false,
        deleted: 0,
        reason:
          "engram delete is not available on this release — upgrade @onenomad/engram-memory to a version that exposes memory_delete",
      };
    }
    try {
      const result = await ctx.engram.delete(
        input.sourceId ? { sourceId: input.sourceId } : { id: input.id! },
      );
      return { ok: true, deleted: result.deleted ?? 0 };
    } catch (err) {
      return {
        ok: false,
        deleted: 0,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
