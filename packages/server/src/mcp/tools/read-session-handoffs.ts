import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Max handoffs to return. Default 5. */
  limit: z.number().int().min(1).max(50).default(5),
  /** Include handoffs marked resolved. Default false. */
  includeResolved: z.boolean().default(false),
  /** Filter to one Claude surface ("claude-desktop", etc.). */
  platform: z.string().default(""),
  /** Filter to one project slug. */
  project: z.string().default(""),
  /** Only handoffs from the last N days. Default 14. */
  days: z.number().int().min(1).max(365).default(14),
});

interface HandoffRow {
  id: string;
  sourceId: string;
  summary: string;
  body: string;
  platform?: string;
  projectSlug?: string;
  date: string;
  resolved: boolean;
  tags: string[];
}

interface Output {
  handoffs: HandoffRow[];
  since: string;
  note?: string;
}

/**
 * Surface recent session handoffs from Engram. Intended to be called
 * at the start of a new Claude session — "what did the last session
 * want me to pick up?" Filters out resolved handoffs by default so
 * they don't pile up indefinitely.
 */
export const readSessionHandoffs: McpTool<typeof inputSchema, Output> = {
  name: "read_session_handoffs",
  description:
    "Read open session handoffs left by previous Claude sessions. " +
    "Call this at the start of a conversation to see what another " +
    "session (on a different Claude surface) wanted you to pick up. " +
    "Filters resolved handoffs by default — pass { includeResolved: " +
    "true } to see the full history.",
  inputSchema,

  async handler(input, ctx) {
    const since = new Date(Date.now() - input.days * 86_400_000);

    let projectSlug: string | undefined;
    if (input.project.trim().length > 0) {
      const project = ctx.taxonomy.findProject(input.project);
      projectSlug = project?.slug ?? input.project;
    }

    const memories = await ctx.engram
      .search({
        query: "session handoff",
        type: "session_handoff",
        ...(projectSlug ? { project: projectSlug } : {}),
        sinceIso: since.toISOString(),
        limit: input.limit * 3,
        domain: "work",
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      })
      .catch((err) => {
        ctx.logger.warn("read_session_handoffs.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

    const rows: HandoffRow[] = [];
    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
      const resolved = tags.includes("status:resolved");
      if (resolved && !input.includeResolved) continue;

      const platformTag = tags
        .find((t) => t.startsWith("platform:"))
        ?.slice("platform:".length);
      if (
        input.platform.trim().length > 0 &&
        platformTag !== input.platform.trim()
      ) {
        continue;
      }

      rows.push({
        id: extractId(mem.id, meta.source_id),
        sourceId:
          typeof meta.source_id === "string" ? meta.source_id : mem.id,
        summary:
          (typeof meta.title === "string" && meta.title.length > 0
            ? meta.title
            : firstLine(mem.content)) ?? "(no summary)",
        body: mem.content,
        ...(platformTag ? { platform: platformTag } : {}),
        ...(typeof meta.project === "string"
          ? { projectSlug: meta.project }
          : Array.isArray(meta.project) && typeof meta.project[0] === "string"
            ? { projectSlug: meta.project[0] as string }
            : {}),
        date:
          typeof meta.date === "string"
            ? meta.date
            : (mem.createdAt ?? since.toISOString()),
        resolved,
        tags: tags.slice(),
      });
    }

    rows.sort((a, b) => b.date.localeCompare(a.date));

    const out: Output = {
      handoffs: rows.slice(0, input.limit),
      since: since.toISOString(),
    };
    if (rows.length === 0) {
      out.note =
        "No open handoffs in this window. If the previous session didn't " +
        "call `leave_session_handoff`, nothing's waiting.";
    }
    return out;
  },
};

function extractId(memId: string, sourceId: unknown): string {
  if (typeof sourceId === "string" && sourceId.startsWith("handoff:")) {
    return sourceId.slice("handoff:".length);
  }
  return memId;
}

function firstLine(body: string): string {
  const stripped = body.replace(/^#+\s*/, "").split("\n")[0] ?? "";
  return stripped.trim().slice(0, 120);
}
