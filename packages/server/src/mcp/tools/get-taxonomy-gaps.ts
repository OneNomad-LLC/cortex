import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** How many recent memories to scan. Higher = more thorough, slower. */
  scanLimit: z.number().int().positive().default(200),
  /** Minimum mentions before a candidate is reported. */
  minMentions: z.number().int().positive().default(2),
});

interface GapCandidate {
  raw: string;
  mentions: number;
  sampleSourceIds: string[];
}

interface Output {
  unknownPeople: GapCandidate[];
  unknownProjects: GapCandidate[];
  identitySelf: "present" | "missing";
  summary: string;
  nextSteps: string[];
}

/**
 * Find taxonomy holes by scanning recent memories for people/project
 * slugs that appear in metadata but aren't defined in
 * people.yaml / projects.yaml. Also flags when no `self: true` person
 * is configured. Claude should review the output and, if anything
 * looks like a real collaborator/project, ask the user to confirm
 * and call add_person / add_project.
 */
export const getTaxonomyGaps: McpTool<typeof inputSchema, Output> = {
  name: "get_taxonomy_gaps",
  description:
    "Scan recent memories for people + project references that " +
    "aren't defined in the taxonomy yet. Returns candidates with " +
    "mention counts. Claude should ask the user to confirm each real " +
    "collaborator/project and call add_person / add_project to fill " +
    "the gaps. Also flags whether a self identity exists. Call on " +
    "demand (user asks 'what's Cortex missing?') or opportunistically " +
    "after a big ingest.",
  inputSchema,

  async handler(input, ctx) {
    const knownPeople = new Set(ctx.taxonomy.listPeople().map((p) => p.slug));
    const knownProjects = new Set(
      ctx.taxonomy.listProjects().map((p) => p.slug),
    );
    const self = ctx.taxonomy.findSelf();

    // Pull a broad sample of recent memories. Engram's search with an
    // empty-ish query + high limit returns by recency when no vector
    // match dominates — good enough for a scan, not a precise query.
    const memories = await ctx.engram
      .search({
        query: "",
        limit: input.scanLimit,
        domain: "work",
        ...(ctx.sessionWorkspace ? { workspace: ctx.sessionWorkspace } : {}),
      })
      .catch(() => []);

    const people = new Map<string, GapCandidate>();
    const projects = new Map<string, GapCandidate>();

    for (const mem of memories) {
      const meta = (mem.metadata ?? {}) as Record<string, unknown>;
      const sourceId =
        typeof meta.source_id === "string" ? meta.source_id : mem.id;

      const peopleRaw = asStringArray(meta.people);
      for (const raw of peopleRaw) {
        if (!raw) continue;
        if (knownPeople.has(raw)) continue;
        // Skip free-text emails / handles — only bare slugs are worth
        // surfacing as "you should add this person." Emails/handles
        // will be picked up as aliases when the user confirms.
        track(people, raw, sourceId);
      }

      const projectRaw = meta.project;
      if (Array.isArray(projectRaw)) {
        for (const raw of projectRaw) {
          if (typeof raw !== "string") continue;
          if (knownProjects.has(raw)) continue;
          track(projects, raw, sourceId);
        }
      } else if (typeof projectRaw === "string" && projectRaw) {
        if (!knownProjects.has(projectRaw)) {
          track(projects, projectRaw, sourceId);
        }
      }
    }

    const unknownPeople = toSortedList(people, input.minMentions);
    const unknownProjects = toSortedList(projects, input.minMentions);

    const nextSteps: string[] = [];
    if (!self) {
      nextSteps.push(
        "No user identity is set. Ask the user their name + email, then call update_user_identity.",
      );
    }
    if (unknownPeople.length > 0) {
      nextSteps.push(
        `${unknownPeople.length} people mentioned ≥${input.minMentions}x but not in the taxonomy. Ask who they are, then call add_person.`,
      );
    }
    if (unknownProjects.length > 0) {
      nextSteps.push(
        `${unknownProjects.length} projects referenced but not defined. Ask the user what each is, then call add_project.`,
      );
    }

    const summary =
      nextSteps.length === 0
        ? "Taxonomy looks up-to-date against recent memories."
        : nextSteps.join(" ");

    return {
      unknownPeople,
      unknownProjects,
      identitySelf: self ? "present" : "missing",
      summary,
      nextSteps,
    };
  },
};

function track(
  map: Map<string, GapCandidate>,
  raw: string,
  sourceId: string,
): void {
  const existing = map.get(raw);
  if (existing) {
    existing.mentions++;
    if (existing.sampleSourceIds.length < 3) {
      existing.sampleSourceIds.push(sourceId);
    }
  } else {
    map.set(raw, { raw, mentions: 1, sampleSourceIds: [sourceId] });
  }
}

function toSortedList(
  map: Map<string, GapCandidate>,
  minMentions: number,
): GapCandidate[] {
  return [...map.values()]
    .filter((c) => c.mentions >= minMentions)
    .sort((a, b) => b.mentions - a.mentions);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
