import type { Widget } from "../types.js";

export interface WhoKnowsRow {
  /** People-taxonomy slug if the person is in people.yaml, else the raw tag. */
  slug: string;
  name: string;
  role?: string;
  email?: string;
  mentions: number;
  lastTouchedIso: string;
  /** Breakdown of memory types — meetings / decisions / action_items / docs. */
  types: Array<{ type: string; count: number }>;
  /** Single-line preview of the person's most recent touch on the topic. */
  lastPreview?: string;
}

export interface WhoKnowsOutput {
  topic: string;
  projectSlug?: string;
  since: string;
  rows: WhoKnowsRow[];
  note?: string;
}

/**
 * "Who should I ask about X?" widget. Ranks people by mention count in
 * recent memories on a topic. Topic can be:
 *   - a project slug (preferred — filters on the `project` metadata field)
 *   - any free text (falls back to full-text search in Engram)
 *
 * Rank = mention count first, most-recent-touch as tiebreak. Enriches
 * with people.yaml (name, role) when the attendee/author is a known
 * person; falls back to the raw tag otherwise so unknown collaborators
 * still show up.
 *
 * Default window is 90 days — wide enough to catch quarterly context
 * without drowning in ancient history.
 */
export const whoKnowsWidget: Widget<WhoKnowsOutput> = {
  name: "who-knows",
  description:
    "Ranks people by recent activity on a topic (project slug or free text).",

  async handler(query, ctx) {
    const rawTopic = (query.get("topic") ?? "").trim();
    const days = clampInt(query.get("days"), 1, 365, 90);
    const limit = clampInt(query.get("limit"), 1, 50, 8);

    if (!rawTopic) {
      return {
        topic: "",
        since: new Date(Date.now() - days * 86_400_000).toISOString(),
        rows: [],
        note: "Pass ?topic=<project|free-text> to see who has context.",
      };
    }

    const since = new Date(Date.now() - days * 86_400_000);
    const project = ctx.taxonomy.findProject(rawTopic);
    const projectSlug = project?.slug;

    const searchArgs = {
      query: projectSlug ? `project:${projectSlug}` : rawTopic,
      ...(projectSlug ? { project: projectSlug } : {}),
      sinceIso: since.toISOString(),
      limit: 500,
      domain: "work",
    };

    const memories = await ctx.engram.search(searchArgs).catch((err) => {
      ctx.logger.warn("widget.who_knows.engram_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    });

    interface Accumulator {
      mentions: number;
      lastTouchedIso: string;
      types: Map<string, number>;
      lastPreview?: string;
    }
    const byPerson = new Map<string, Accumulator>();

    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const dateStr =
        typeof meta.date === "string"
          ? meta.date
          : (mem.createdAt ?? undefined);
      if (!dateStr) continue;

      const people = collectPeople(meta);
      if (people.length === 0) continue;

      const type =
        (typeof meta.type === "string" ? meta.type : mem.type) ?? "other";

      for (const raw of people) {
        const slug = resolveSlug(raw, ctx);
        let acc = byPerson.get(slug);
        if (!acc) {
          acc = {
            mentions: 0,
            lastTouchedIso: "",
            types: new Map(),
          };
          byPerson.set(slug, acc);
        }
        acc.mentions += 1;
        acc.types.set(type, (acc.types.get(type) ?? 0) + 1);
        if (dateStr.localeCompare(acc.lastTouchedIso) > 0) {
          acc.lastTouchedIso = dateStr;
          acc.lastPreview = truncate(mem.content, 140);
        }
      }
    }

    const rows: WhoKnowsRow[] = [];
    for (const [slug, acc] of byPerson) {
      const person = ctx.taxonomy.findPerson(slug);
      const row: WhoKnowsRow = {
        slug,
        name: person?.name ?? prettifyTag(slug),
        mentions: acc.mentions,
        lastTouchedIso: acc.lastTouchedIso,
        types: Array.from(acc.types.entries())
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count),
      };
      if (person?.role) row.role = person.role;
      if (person?.email) row.email = person.email;
      if (acc.lastPreview) row.lastPreview = acc.lastPreview;
      rows.push(row);
    }

    rows.sort((a, b) => {
      if (b.mentions !== a.mentions) return b.mentions - a.mentions;
      return b.lastTouchedIso.localeCompare(a.lastTouchedIso);
    });

    const out: WhoKnowsOutput = {
      topic: rawTopic,
      since: since.toISOString(),
      rows: rows.slice(0, limit),
    };
    if (projectSlug) out.projectSlug = projectSlug;
    if (rows.length === 0) {
      out.note = `No attendees or authors tied to '${rawTopic}' in the last ${days} days.`;
    }
    return out;
  },
};

function collectPeople(meta: Record<string, unknown>): string[] {
  const out: string[] = [];
  const raw = meta.people;
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === "string" && v.length > 0) out.push(v);
    }
  }
  const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
  for (const t of tags) {
    if (t.startsWith("owner:")) out.push(t.slice("owner:".length));
  }
  return out;
}

function resolveSlug(
  raw: string,
  ctx: { taxonomy: { findPerson(q: string): { slug: string } | undefined } },
): string {
  const person = ctx.taxonomy.findPerson(raw);
  return person ? person.slug : raw;
}

function prettifyTag(raw: string): string {
  if (raw.includes("@")) return raw;
  return raw.replace(/[-_]/g, " ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function clampInt(
  raw: string | null,
  lo: number,
  hi: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
