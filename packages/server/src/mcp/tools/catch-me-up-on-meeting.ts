import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Meeting source_id (e.g. "loom:rec:abc" or the thread root). */
  sourceId: z.string().default(""),
  /** Or a URL — used to look up the meeting in Engram by source_url. */
  url: z.string().default(""),
  /** Or a search query to find a recent meeting by title. */
  query: z.string().default(""),
});

interface ActionItem {
  content: string;
  owner?: string;
  due?: string;
  source_id: string;
}

interface Decision {
  content: string;
  owner?: string;
  source_id: string;
}

interface Output {
  found: boolean;
  meeting?: {
    title?: string;
    date?: string;
    source?: string;
    url?: string;
  };
  brief?: string;
  decisions: Decision[];
  action_items: ActionItem[];
  hint?: string;
}

export const catchMeUpOnMeeting: McpTool<typeof inputSchema, Output> = {
  name: "catch_me_up_on_meeting",
  description:
    "Pull a meeting's brief, decisions, and action items from Engram. " +
    "Specify by `sourceId` (most precise), `url` (Loom/Meet link), or " +
    "`query` (fuzzy search). Returns the whole meeting packet so you " +
    "can read a brief without leaving your editor.",
  inputSchema,

  async handler(input, ctx) {
    if (!input.sourceId && !input.url && !input.query) {
      return {
        found: false,
        decisions: [],
        action_items: [],
        hint: "Pass at least one of: sourceId, url, query.",
      };
    }

    const effectiveQuery =
      input.query.trim() ||
      input.url.trim() ||
      input.sourceId.trim();

    const memories = await ctx.engram
      .search({
        query: effectiveQuery,
        type: "meeting",
        limit: 5,
        domain: "work",
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      })
      .catch((err) => {
        ctx.logger.warn("catch_me_up_on_meeting.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

    // Pick the best match: exact source_id hit, else url hit, else first result.
    const matchedMeeting =
      memories.find((m) => {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        return (
          (input.sourceId && meta.source_id === input.sourceId) ||
          (input.url && meta.source_url === input.url)
        );
      }) ?? memories[0];

    if (!matchedMeeting) {
      return {
        found: false,
        decisions: [],
        action_items: [],
        hint: `No meeting found for '${effectiveQuery}'. Make sure the meeting has been ingested.`,
      };
    }

    const meta = (matchedMeeting.metadata ?? {}) as Record<string, unknown>;
    const rootId = pickRootId(matchedMeeting.id, meta);

    // Pull every memory sharing that root — brief, decisions, action_items, chunks.
    const related = await ctx.engram
      .search({
        query: rootId,
        limit: 50,
        domain: "work",
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      })
      .catch(() => []);

    const sameRoot = related.filter((m) => {
      const mm = (m.metadata ?? {}) as Record<string, unknown>;
      const sid = mm.source_id as string | undefined;
      return (
        sid === rootId ||
        (typeof sid === "string" && sid.startsWith(`${rootId}#`))
      );
    });

    const brief = sameRoot.find((m) => {
      const mm = (m.metadata ?? {}) as Record<string, unknown>;
      return mm.type === "brief";
    });

    const decisions: Decision[] = sameRoot
      .filter((m) => ((m.metadata ?? {}) as Record<string, unknown>).type === "decision")
      .map((m) => ({
        content: m.content,
        source_id: ((m.metadata ?? {}) as Record<string, unknown>).source_id as string,
        ...extractOwner(m.metadata),
      }));

    const action_items: ActionItem[] = sameRoot
      .filter((m) => ((m.metadata ?? {}) as Record<string, unknown>).type === "action_item")
      .map((m) => {
        const mm = (m.metadata ?? {}) as Record<string, unknown>;
        const tags = Array.isArray(mm.tags) ? (mm.tags as string[]) : [];
        const due = tags.find((t) => t.startsWith("due:"))?.slice(4);
        return {
          content: m.content,
          source_id: mm.source_id as string,
          ...(due ? { due } : {}),
          ...extractOwner(m.metadata),
        };
      });

    return {
      found: true,
      meeting: {
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        ...(typeof meta.date === "string" ? { date: meta.date } : {}),
        ...(typeof meta.source === "string" ? { source: meta.source } : {}),
        ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
      },
      ...(brief ? { brief: brief.content } : {}),
      decisions,
      action_items,
    };
  },
};

/**
 * Extract the root source_id — the part before the first `#suffix` our
 * pipelines append (e.g. `loom:rec:xyz` from `loom:rec:xyz#decision-0`).
 */
function pickRootId(
  fallback: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const sid = (metadata ?? {}).source_id;
  if (typeof sid === "string") {
    const hashIdx = sid.indexOf("#");
    return hashIdx > 0 ? sid.slice(0, hashIdx) : sid;
  }
  return fallback;
}

function extractOwner(
  metadata: Record<string, unknown> | undefined,
): { owner?: string } {
  const tags = (metadata ?? {}).tags;
  if (!Array.isArray(tags)) return {};
  const ownerTag = (tags as unknown[]).find(
    (t): t is string => typeof t === "string" && t.startsWith("owner:"),
  );
  return ownerTag ? { owner: ownerTag.slice("owner:".length) } : {};
}
