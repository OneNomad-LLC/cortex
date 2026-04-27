import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  body: z.string().default(""),
  currentTitle: z.string().optional(),
  currentTags: z.array(z.string()).optional(),
  currentProject: z.string().optional(),
});

interface Output {
  title: string;
  tags: string[];
  project?: string;
  /** True when an LLM produced the suggestion. False when we fell back. */
  llm: boolean;
}

const TITLE_MAX = 70;
const MAX_TAGS = 5;
const TAG_MAX = 24;
const BODY_TRUNCATE = 4000;

/**
 * Suggest a title and tags for a note from its body. Used by the
 * dashboard editor to auto-populate metadata so the user doesn't
 * have to think about it. Falls back to a deterministic heuristic
 * when no LLM is configured.
 */
export const noteSuggestMetadata: McpTool<typeof inputSchema, Output> = {
  name: "note_suggest_metadata",
  description:
    "Generate a concise title and 3-5 search tags for a note from its " +
    "markdown body. Returns the user's existing title/tags when the body " +
    "is too short to suggest meaningfully. Project is only suggested when " +
    "the body confidently matches a slug from projects.yaml.",
  inputSchema,

  async handler(input, ctx) {
    const trimmedBody = input.body.trim();
    if (trimmedBody.length < 20) {
      return {
        title: input.currentTitle?.trim() || "Untitled note",
        tags: input.currentTags ?? [],
        ...(input.currentProject ? { project: input.currentProject } : {}),
        llm: false,
      };
    }

    const projectSlugs = ctx.taxonomy
      .listProjects({ activeOnly: false })
      .map((p) => p.slug);

    if (!ctx.llmRouter) {
      return {
        ...heuristic(trimmedBody, input),
        llm: false,
      };
    }

    try {
      const result = await suggestViaLLM({
        llmRouter: ctx.llmRouter,
        body: trimmedBody,
        ...(input.currentTitle ? { currentTitle: input.currentTitle } : {}),
        currentTags: input.currentTags ?? [],
        projectSlugs,
      });
      const project =
        result.project && projectSlugs.includes(result.project)
          ? result.project
          : input.currentProject;
      return {
        title: clamp(result.title, TITLE_MAX) || input.currentTitle?.trim() || "Untitled note",
        tags: dedupeTags([...(input.currentTags ?? []), ...result.tags]),
        ...(project ? { project } : {}),
        llm: true,
      };
    } catch (err) {
      ctx.logger.warn("note_suggest_metadata.llm_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ...heuristic(trimmedBody, input),
        llm: false,
      };
    }
  },
};

async function suggestViaLLM(args: {
  llmRouter: NonNullable<
    ReturnType<() => import("@onenomad/cortex-llm-core").LLMRouter>
  >;
  body: string;
  currentTitle?: string;
  currentTags: string[];
  projectSlugs: string[];
}): Promise<{ title: string; tags: string[]; project?: string }> {
  const projectsLine =
    args.projectSlugs.length > 0
      ? `Allowed project slugs (pick at most one, or null): ${args.projectSlugs.join(", ")}`
      : "No project list configured — set `project` to null.";

  const prompt = [
    "You generate metadata for a personal note. Output ONE JSON object, no prose.",
    "",
    "Schema:",
    `  title: short headline, max ${TITLE_MAX} chars, sentence case, no trailing period`,
    `  tags: array of 3-${MAX_TAGS} short kebab-case keywords, each <=${TAG_MAX} chars,`,
    "        optimised for later search (concepts, entities, action types)",
    "  project: one of the allowed slugs below, or null if none clearly fits",
    "",
    projectsLine,
    "",
    "Rules:",
    "- The title must summarise the body, not echo a hint or the first words.",
    "- Tags must be specific. Avoid generic ones like 'note', 'todo', 'misc'.",
    "- If the body is a list, tag the topic, not the format.",
    "- Lowercase tags, hyphens for multi-word, never spaces.",
    "",
    args.currentTitle
      ? `Current title (improve only if clearly better): ${args.currentTitle}`
      : "No current title.",
    args.currentTags.length > 0
      ? `User-added tags (keep these): ${args.currentTags.join(", ")}`
      : "No user-added tags.",
    "",
    "BODY:",
    args.body.slice(0, BODY_TRUNCATE),
    "",
    "Respond with JSON only:",
    '{"title": "...", "tags": ["...", "..."], "project": null}',
  ].join("\n");

  const response = await args.llmRouter.complete({
    task: "classify",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    maxTokens: 300,
  });

  return parseSuggestion(response.content);
}

function parseSuggestion(raw: string): {
  title: string;
  tags: string[];
  project?: string;
} {
  const json = extractJsonObject(raw);
  if (!json) throw new Error("LLM did not return a JSON object");
  const parsed = JSON.parse(json) as {
    title?: unknown;
    tags?: unknown;
    project?: unknown;
  };
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags
        .filter((t): t is string => typeof t === "string")
        .map(normalizeTag)
        .filter((t) => t.length > 0)
        .slice(0, MAX_TAGS)
    : [];
  const project =
    typeof parsed.project === "string" && parsed.project.trim().length > 0
      ? parsed.project.trim()
      : undefined;
  return { title, tags, ...(project ? { project } : {}) };
}

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = ((fenced?.[1] ?? text) || "").trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, TAG_MAX);
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function clamp(s: string, max: number): string {
  const trimmed = s.trim().replace(/\.$/, "");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Deterministic fallback when no LLM is wired. Pulls the first
 * markdown heading or first non-empty sentence as the title; tags
 * from frequent multi-word noun-ish tokens. Not great — that's why
 * we prefer the LLM path — but ships something usable offline.
 */
function heuristic(
  body: string,
  input: z.output<typeof inputSchema>,
): { title: string; tags: string[]; project?: string } {
  const headingMatch = body.match(/^\s*#{1,3}\s+(.+)$/m);
  let title = input.currentTitle?.trim() ?? "";
  if (!title) {
    if (headingMatch) {
      title = clamp(headingMatch[1] ?? "", TITLE_MAX);
    } else {
      const firstLine = body
        .split(/\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
      const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
      title = clamp(firstSentence, TITLE_MAX);
    }
  }
  if (!title) title = "Untitled note";

  const stop = new Set([
    "the", "and", "for", "you", "with", "this", "that", "from",
    "have", "are", "was", "but", "not", "all", "any", "can",
    "will", "just", "would", "could", "should", "into", "their",
    "them", "then", "than", "what", "when", "which", "while",
    "your", "ours", "they", "about",
  ]);
  const counts = new Map<string, number>();
  for (const token of body.toLowerCase().split(/[^a-z0-9-]+/)) {
    if (token.length < 4 || stop.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const candidates = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, MAX_TAGS);
  const tags = dedupeTags([...(input.currentTags ?? []), ...candidates]);

  const result: { title: string; tags: string[]; project?: string } = {
    title,
    tags,
  };
  if (input.currentProject) result.project = input.currentProject;
  return result;
}
