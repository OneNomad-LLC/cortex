import { z } from "zod";
import type { McpTool } from "../tool.js";
import { getProjectContext } from "./get-project-context.js";
import { searchRelated } from "./search-related.js";

const inputSchema = z.object({
  /**
   * Entity identifier. For `type='project'`, a slug or alias. For
   * `type='person'`, a slug, email, or display name. For 'topic',
   * any free-text label that names the thing you want context on
   * (e.g. "auth migration", "payment processor evaluation").
   */
  entity: z.string().min(1),
  /**
   * Entity kind. `project` and `person` route through the taxonomy
   * (canonical structured data + recent activity). `topic` falls back
   * to a top-K hybrid search since it has no canonical record.
   */
  type: z.enum(["project", "person", "topic"]).default("topic"),
  /** Recent-activity count when applicable. Default 10, cap 50. */
  topK: z.number().int().positive().max(50).default(10),
  /** Days to look back for recent activity. Default 60. */
  recentDays: z.number().int().min(1).max(365).default(60),
});

interface DossierResult {
  entity: string;
  type: "project" | "person" | "topic";
  found: boolean;
  /**
   * Canonical structured data when the entity has a taxonomy record:
   *   - project: { slug, name, description, active, aliases, sources, people }
   *   - person:  { slug, name, email, role? }
   *   - topic:   undefined (no canonical record)
   */
  canonical?: Record<string, unknown>;
  /** Top relevant chunks (recent activity for project/person; ranked search for topic). */
  related: Array<{
    id: string;
    snippet: string;
    title?: string;
    type?: string;
    source?: string;
    project?: string | string[];
    date?: string;
    source_url?: string;
    score?: number;
  }>;
  hint?: string;
}

/**
 * Knowledge-base dossier.
 *
 * Mirrors the Engram `memory_dossier({entity})` pattern from the local-
 * context roadmap, but at the org-knowledge level. Pre-loads canonical
 * structured data PLUS top relevant chunks for an entity in one call so
 * the consumer (Pyre's coordinator, an agent, a chat reply) doesn't
 * need to chain `get_project_context` + `search_related` itself.
 *
 * Implementation:
 *   - `type=project`: routes through get_project_context (taxonomy +
 *     recent activity scoped to the project).
 *   - `type=person`: looks up the person in the taxonomy, then runs a
 *     name-based search for recent mentions/activity.
 *   - `type=topic`: no canonical record; returns a top-K search by name.
 */
export const kbDossier: McpTool<typeof inputSchema, DossierResult> = {
  name: "kb_dossier",
  description:
    "Pre-load an entity-shaped dossier from the knowledge base. " +
    "Returns canonical structured data (when the entity is a known " +
    "project or person) plus top relevant chunks. Cheaper than chaining " +
    "get_project_context + search_related — one call covers both. " +
    "Use this BEFORE generating an answer about a known project/person; " +
    "fall back to kb_search for ad-hoc topic queries that don't have a " +
    "canonical record.",
  inputSchema,

  async handler(input, ctx) {
    if (input.type === "project") {
      const ctxResult = await getProjectContext.handler(
        {
          project: input.entity,
          recentLimit: input.topK,
          recentDays: input.recentDays,
        },
        ctx,
      );
      const baseResult: DossierResult = {
        entity: input.entity,
        type: "project",
        found: ctxResult.found,
        related: (ctxResult.recent_activity ?? []).map((a) => {
          const r: DossierResult["related"][number] = {
            id: a.id,
            snippet: a.preview,
          };
          if (a.title) r.title = a.title;
          if (a.type) r.type = a.type;
          if (a.source) r.source = a.source;
          if (a.date) r.date = a.date;
          if (a.url) r.source_url = a.url;
          return r;
        }),
      };
      if (ctxResult.project) {
        baseResult.canonical = {
          ...ctxResult.project,
          ...(ctxResult.people ? { people: ctxResult.people } : {}),
        };
      }
      if (ctxResult.hint) baseResult.hint = ctxResult.hint;
      return baseResult;
    }

    if (input.type === "person") {
      const person = ctx.taxonomy.findPerson(input.entity);
      const sinceIso = new Date(
        Date.now() - input.recentDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const queryName = person?.name ?? input.entity;
      const search = await searchRelated.handler(
        { query: queryName, limit: input.topK, since: sinceIso },
        ctx,
      );
      const result: DossierResult = {
        entity: input.entity,
        type: "person",
        found: !!person,
        related: search.results.map((r) => {
          const out: DossierResult["related"][number] = {
            id: r.id,
            snippet: r.snippet,
          };
          if (r.title) out.title = r.title;
          if (r.type) out.type = r.type;
          if (r.source) out.source = r.source;
          if (r.project) out.project = r.project;
          if (r.date) out.date = r.date;
          if (r.source_url) out.source_url = r.source_url;
          if (typeof r.score === "number") out.score = r.score;
          return out;
        }),
      };
      if (person) {
        result.canonical = {
          slug: person.slug,
          name: person.name,
          email: person.email,
          ...(person.role ? { role: person.role } : {}),
        };
      } else {
        result.hint = `No person matched '${input.entity}'. Returning name-keyed search results across the KB.`;
      }
      return result;
    }

    // Topic — no canonical record, top-K hybrid search.
    const sinceIso = new Date(
      Date.now() - input.recentDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const search = await searchRelated.handler(
      { query: input.entity, limit: input.topK, since: sinceIso },
      ctx,
    );
    return {
      entity: input.entity,
      type: "topic",
      found: search.count > 0,
      related: search.results.map((r) => {
        const out: DossierResult["related"][number] = {
          id: r.id,
          snippet: r.snippet,
        };
        if (r.title) out.title = r.title;
        if (r.type) out.type = r.type;
        if (r.source) out.source = r.source;
        if (r.project) out.project = r.project;
        if (r.date) out.date = r.date;
        if (r.source_url) out.source_url = r.source_url;
        if (typeof r.score === "number") out.score = r.score;
        return out;
      }),
    };
  },
};
