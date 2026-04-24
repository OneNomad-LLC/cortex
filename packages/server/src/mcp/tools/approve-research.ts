import { z } from "zod";
import { setApproval, type ApprovalStatus } from "../../approvals.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * Root source_id of the reference artifact to update. Research outputs
   * have the shape `cortex:research:<topic-slug>`. Pass the bare root —
   * all #brief / #finding children are treated as governed by it.
   */
  sourceId: z.string().min(1),
  status: z
    .enum(["draft", "in_review", "approved", "revoked"])
    .default("approved"),
  /** Optional reviewer slug (who made the call). */
  reviewer: z.string().default(""),
  /** Optional one-line rationale. */
  note: z.string().default(""),
});

interface Output {
  sourceId: string;
  status: ApprovalStatus;
  decidedAt: string;
  reviewer?: string;
  note?: string;
  reIngestAttempted: boolean;
  reIngestSuccess: boolean;
  hint?: string;
}

export const approveResearch: McpTool<typeof inputSchema, Output> = {
  name: "approve_research",
  description:
    "Mark a reference artifact as approved / in_review / revoked. " +
    "Research output starts as `draft` until a reviewer signs off. " +
    "Decisions are stored in ~/.cortex/approvals.json (source of " +
    "truth) and the underlying memory is re-ingested as a best-effort " +
    "metadata refresh.",
  inputSchema,

  async handler(input, ctx) {
    if (!input.sourceId.startsWith("cortex:research:")) {
      return {
        sourceId: input.sourceId,
        status: input.status,
        decidedAt: new Date().toISOString(),
        reIngestAttempted: false,
        reIngestSuccess: false,
        hint: "This tool expects a reference source_id like 'cortex:research:<topic>'. Other types aren't governed yet.",
      };
    }

    const record = await setApproval({
      sourceId: input.sourceId,
      status: input.status,
      ...(input.reviewer ? { reviewer: input.reviewer } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    });

    // Best-effort re-ingest: look up the brief memory (suffix `#brief`),
    // re-ingest with updated status. Engram may dedupe this to a no-op;
    // approvals.json is still the source of truth.
    let reIngestAttempted = false;
    let reIngestSuccess = false;
    try {
      const matches = await ctx.engram.search({
        query: input.sourceId,
        limit: 10,
        domain: "work",
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      });
      const brief = matches.find((m) => {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        return (
          meta.source_id === `${input.sourceId}#brief` ||
          (typeof meta.source_id === "string" &&
            meta.source_id.startsWith(`${input.sourceId}#`) &&
            meta.type === "brief")
        );
      });
      if (brief) {
        reIngestAttempted = true;
        const meta = (brief.metadata ?? {}) as Record<string, unknown>;
        // Preserve (or stamp) workspace — if the brief was ingested
        // pre-scoping its metadata has no workspace field; keeping it
        // absent would leak it across workspaces on re-ingest. Honor
        // the existing value when present.
        const nextWorkspace =
          (typeof meta.workspace === "string" ? meta.workspace : undefined) ??
          ctx.sessionWorkspace ??
          undefined;
        await ctx.engram.ingest({
          content: brief.content,
          metadata: {
            ...meta,
            status: input.status,
            ...(nextWorkspace ? { workspace: nextWorkspace } : {}),
          },
        });
        reIngestSuccess = true;
      }
    } catch (err) {
      ctx.logger.warn("approve_research.reingest_failed", {
        sourceId: input.sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      sourceId: input.sourceId,
      status: record.status,
      decidedAt: record.decidedAt,
      ...(record.reviewer ? { reviewer: record.reviewer } : {}),
      ...(record.note ? { note: record.note } : {}),
      reIngestAttempted,
      reIngestSuccess,
    };
  },
};
