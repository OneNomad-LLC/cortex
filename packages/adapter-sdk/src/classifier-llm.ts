import type {
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  TaxonomyReader,
} from "@onenomad/przm-cortex-core";

/**
 * LLM call surface the classifier needs. Matches the shape on
 * AdapterContext.llm so adapters can pass `ctx.llm` directly.
 */
export interface LLMClassifierLLM {
  complete(args: {
    task: string;
    prompt: string;
    system?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface LLMClassifierOptions {
  taxonomy: TaxonomyReader;
  llm: LLMClassifierLLM;
  /** Items below this confidence go to an empty projects array. Default 0.35. */
  minConfidence?: number;
  /** Max characters of item content to include in the prompt. Default 4000. */
  maxContentChars?: number;
  /** Cap on project tags we'll believe the model. Default 3. */
  maxProjects?: number;
}

interface LLMResponse {
  projects?: string[];
  confidence?: number;
  reason?: string;
}

/**
 * Classifies a `NormalizedItem` against the project taxonomy using the
 * LLM router's `classify` task binding.
 *
 * Called from an adapter's `classify()` when rule-based matching misses.
 * The prompt includes project slugs + names + aliases + descriptions so
 * the model has enough context to pick one. Output is strict JSON:
 *
 *   { "projects": ["slug"], "confidence": 0.0-1.0, "reason": "short" }
 *
 * Anything off-spec is treated as "no match" with confidence 0.
 */
export class LLMClassifier {
  constructor(private readonly opts: LLMClassifierOptions) {}

  async classify(
    item: NormalizedItem,
    _cctx: ClassificationContext,
  ): Promise<
    Pick<ClassifiedItem, "projects" | "confidence" | "classificationMethod">
  > {
    const projects = this.opts.taxonomy.listProjects({ activeOnly: true });
    if (projects.length === 0) {
      return {
        projects: [],
        confidence: 0,
        classificationMethod: "content-llm",
      };
    }

    const maxContent = this.opts.maxContentChars ?? 4_000;
    const minConfidence = this.opts.minConfidence ?? 0.35;
    const maxProjects = this.opts.maxProjects ?? 3;

    const prompt = this.buildPrompt(item, projects, maxContent);
    let raw: string | undefined;
    try {
      raw = await this.opts.llm.complete({
        task: "classify",
        prompt,
        temperature: 0,
        maxTokens: 256,
      });
    } catch {
      return {
        projects: [],
        confidence: 0,
        classificationMethod: "content-llm",
      };
    }

    if (typeof raw !== "string" || raw.trim().length === 0) {
      return {
        projects: [],
        confidence: 0,
        classificationMethod: "content-llm",
      };
    }

    const parsed = this.safeParse(raw);
    if (!parsed) {
      return {
        projects: [],
        confidence: 0,
        classificationMethod: "content-llm",
      };
    }

    const knownSlugs = new Set(projects.map((p) => p.slug));
    const selected = (parsed.projects ?? [])
      .filter((s) => typeof s === "string" && knownSlugs.has(s))
      .slice(0, maxProjects);
    const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0));

    if (selected.length === 0 || confidence < minConfidence) {
      return {
        projects: [],
        confidence,
        classificationMethod: "content-llm",
      };
    }

    return {
      projects: selected,
      confidence,
      classificationMethod: "content-llm",
    };
  }

  private buildPrompt(
    item: NormalizedItem,
    projects: ReturnType<TaxonomyReader["listProjects"]>,
    maxContent: number,
  ): string {
    const projectLines = projects
      .map((p) => {
        const aliases =
          p.aliases.length > 0 ? ` (aka ${p.aliases.join(", ")})` : "";
        const desc = p.description ? ` — ${p.description}` : "";
        return `- ${p.slug}${aliases}${desc}`;
      })
      .join("\n");

    const truncated =
      item.content.length > maxContent
        ? item.content.slice(0, maxContent) + "\n…[truncated]"
        : item.content;

    return [
      "You classify work content into projects. Return STRICT JSON only.",
      "",
      "PROJECTS (slug (aliases) — description):",
      projectLines,
      "",
      "Return:",
      `  { "projects": ["slug", ...], "confidence": 0.0-1.0, "reason": "one short sentence" }`,
      "",
      "Rules:",
      "- `projects` is an array of slugs chosen from the list above. Empty array if unsure.",
      "- Pick 1 project unless the content clearly belongs to multiple.",
      "- `confidence` 0.0-1.0. Below 0.5 signals 'uncertain'.",
      "- No prose outside the JSON. No ```fences.",
      "",
      `SOURCE: ${item.sourceType}`,
      `TITLE: ${item.title}`,
      "",
      "CONTENT:",
      truncated,
    ].join("\n");
  }

  private safeParse(raw: string): LLMResponse | null {
    const trimmed = raw.trim();
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;
    const m = fence.exec(trimmed);
    const candidate = m?.[1] ?? trimmed;
    try {
      return JSON.parse(candidate) as LLMResponse;
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1)) as LLMResponse;
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}
