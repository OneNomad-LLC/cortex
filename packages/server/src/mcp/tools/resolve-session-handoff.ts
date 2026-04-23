import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * Handoff id (returned by `leave_session_handoff`) or the full
   * source_id (`handoff:<uuid>`). Either works.
   */
  id: z.string().min(1),
  /**
   * Optional resolution note appended to the body. Short is fine —
   * "addressed in PR #42", "decided no, not worth doing."
   */
  note: z.string().default(""),
});

interface Output {
  id: string;
  sourceId: string;
  resolved: boolean;
  resolvedAt: string;
  note?: string;
}

/**
 * Mark a session handoff as resolved. Stops it from surfacing in
 * future `read_session_handoffs` calls unless the caller asks for
 * resolved entries explicitly.
 *
 * Implementation: Engram dedupes by `source_id`, so we re-ingest the
 * handoff memory with `status:resolved` added to its tags. Original
 * body is preserved and optionally augmented with a resolution note.
 */
export const resolveSessionHandoff: McpTool<typeof inputSchema, Output> = {
  name: "resolve_session_handoff",
  description:
    "Mark a session handoff as resolved so it stops appearing in " +
    "`read_session_handoffs`. Takes the handoff id or full source_id. " +
    "Accepts an optional note summarizing how it was addressed — the " +
    "note is appended to the handoff body.",
  inputSchema,

  async handler(input, ctx) {
    const sourceId = input.id.startsWith("handoff:")
      ? input.id
      : `handoff:${input.id}`;
    const id = sourceId.slice("handoff:".length);

    const hits = await ctx.engram.search({
      query: `source_id:${sourceId}`,
      type: "session_handoff",
      limit: 5,
      domain: "work",
    });
    const memory = hits.find((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      return meta.source_id === sourceId;
    });
    if (!memory) {
      throw new Error(
        `resolve_session_handoff: no handoff found with id '${input.id}'. ` +
          `Has it been written yet? Try \`read_session_handoffs({ includeResolved: true })\`.`,
      );
    }

    const meta = (memory.metadata ?? {}) as Record<string, unknown>;
    const tags = new Set<string>(
      Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    );
    // Flip status:open → status:resolved. Use a set so duplicate
    // resolve calls don't double-write.
    for (const t of [...tags]) {
      if (t.startsWith("status:")) tags.delete(t);
    }
    tags.add("status:resolved");

    const resolvedAt = new Date().toISOString();
    tags.add(`resolved_at:${resolvedAt}`);

    const body = input.note.trim().length > 0
      ? `${memory.content.trimEnd()}\n\n## Resolved\n\n_${resolvedAt}_\n\n${input.note.trim()}`
      : memory.content;

    await ctx.engram.ingest({
      content: body,
      metadata: {
        ...meta,
        tags: [...tags],
        date: typeof meta.date === "string" ? meta.date : resolvedAt,
      },
    });

    const out: Output = {
      id,
      sourceId,
      resolved: true,
      resolvedAt,
    };
    if (input.note.trim()) out.note = input.note.trim();
    return out;
  },
};
