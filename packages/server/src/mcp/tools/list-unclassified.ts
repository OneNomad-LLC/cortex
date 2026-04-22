import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** Items with confidence at or below this land in the queue. */
  confidenceMax: z.number().min(0).max(1).default(0.5),
  /** Days back to consider. */
  days: z.number().int().min(1).max(365).default(14),
  /** Cap on items returned (after grouping). */
  limit: z.number().int().min(1).max(500).default(100),
  /** Restrict to one source type (e.g. "slack") if set. */
  source: z.string().default(""),
});

interface UnclassifiedItem {
  sourceId: string;
  title?: string;
  type: string;
  source?: string;
  confidence: number;
  date?: string;
  url?: string;
  preview: string;
  currentProjects: string[];
}

interface SourceBucket {
  source: string;
  count: number;
  items: UnclassifiedItem[];
}

interface Output {
  since: string;
  confidenceMax: number;
  totalQueued: number;
  bySource: SourceBucket[];
  hint?: string;
}

export const listUnclassified: McpTool<typeof inputSchema, Output> = {
  name: "list_unclassified",
  description:
    "Return memories that landed with low or zero project confidence — " +
    "the classifier review queue. Grouped by source so you can spot " +
    "systemic misses (e.g. 'all my Slack threads are unclassified' → " +
    "add a channelToProject rule). Read-only; re-classification is " +
    "manual for now.",
  inputSchema,

  async handler(input, ctx) {
    const since = new Date(Date.now() - input.days * 86_400_000);

    const memories = await ctx.engram
      .search({
        query: "unclassified review queue",
        ...(input.source ? { source: input.source } : {}),
        sinceIso: since.toISOString(),
        limit: input.limit * 3,
        domain: "work",
      })
      .catch((err) => {
        ctx.logger.warn("list_unclassified.engram_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });

    const items: UnclassifiedItem[] = [];
    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const confidenceRaw = meta.confidence;
      const confidence =
        typeof confidenceRaw === "number" ? confidenceRaw : 0;
      const currentProjects = normalizeProjects(meta.project);
      const unclassified =
        currentProjects.length === 0 || confidence <= input.confidenceMax;
      if (!unclassified) continue;

      items.push({
        sourceId: (meta.source_id as string | undefined) ?? mem.id,
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        type: (meta.type as string | undefined) ?? mem.type ?? "unknown",
        ...(typeof meta.source === "string" ? { source: meta.source } : {}),
        confidence,
        ...(typeof meta.date === "string"
          ? { date: meta.date }
          : mem.createdAt
            ? { date: mem.createdAt }
            : {}),
        ...(typeof meta.source_url === "string" ? { url: meta.source_url } : {}),
        preview: mem.content.slice(0, 200),
        currentProjects,
      });
    }

    items.sort(
      (a, b) =>
        a.confidence - b.confidence ||
        (b.date ?? "").localeCompare(a.date ?? ""),
    );

    // Group by source.
    const byKey = new Map<string, UnclassifiedItem[]>();
    for (const item of items.slice(0, input.limit)) {
      const key = item.source ?? "unknown";
      const bucket = byKey.get(key) ?? [];
      bucket.push(item);
      byKey.set(key, bucket);
    }
    const bySource: SourceBucket[] = [...byKey.entries()]
      .map(([source, bucketItems]) => ({
        source,
        count: bucketItems.length,
        items: bucketItems,
      }))
      .sort((a, b) => b.count - a.count);

    const total = bySource.reduce((n, b) => n + b.count, 0);

    return {
      since: since.toISOString(),
      confidenceMax: input.confidenceMax,
      totalQueued: total,
      bySource,
      ...(total === 0
        ? { hint: "Nothing queued for review. All recent items cleared classification." }
        : {}),
    };
  },
};

function normalizeProjects(raw: unknown): string[] {
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  return [];
}
