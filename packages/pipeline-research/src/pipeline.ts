import { createHash } from "node:crypto";
import type { MemoryMetadata } from "@onenomad/cortex-core";
import type {
  Pipeline,
  PipelineContext,
  PipelineMemory,
} from "@onenomad/cortex-pipeline-core";
import type {
  ResearchExtracted,
  ResearchInput,
  ResearchPipelineOptions,
} from "./types.js";

export function createResearchPipeline(
  opts: ResearchPipelineOptions = {},
): Pipeline<ResearchInput, PipelineMemory> {
  const maxFindings = opts.maxFindings ?? 10;
  const maxItemChars = opts.maxItemChars ?? 2_000;

  return {
    id: "@onenomad/cortex-pipeline-research",
    version: "0.1.0",

    async run(
      input: ResearchInput,
      ctx: PipelineContext,
    ): Promise<PipelineMemory[]> {
      const topicSlug = normalizeTopic(input.topic);
      const baseMetadata = buildBaseMetadata(input, topicSlug, ctx.traceId);

      let extracted: ResearchExtracted;
      let brief: string;

      if (ctx.llm) {
        // Pass 1: structural extraction from retrieved context.
        const extractPrompt = buildExtractPrompt(input, maxItemChars);
        const pass1Raw = await ctx.llm.complete({
          task: "structural",
          prompt: extractPrompt,
          temperature: 0,
          maxTokens: 2048,
        });
        extracted = parseJsonLoose<ResearchExtracted>(pass1Raw) ?? {
          summary: "",
          findings: [],
        };

        // Pass 2: synthesize a brief.
        const briefPrompt = buildBriefPrompt(input, extracted);
        brief = await ctx.llm.complete({
          task: "brief",
          prompt: briefPrompt,
          temperature: 0.2,
          maxTokens: 2048,
        });
      } else {
        // Cortex 0.2 — no local LLM. Try the enrichment callback for
        // a summary; we can't do structured findings extraction
        // without a more elaborate protocol, so we degrade to a
        // single brief memory plus the raw retrieved context.
        const concatenated = input.retrievedContext
          .map((c) => c.content)
          .join("\n\n---\n\n");
        const summary = await ctx.enrichment
          ?.enrich({
            type: "summarize",
            payload: { content: concatenated, hint: input.topic },
            context: {
              topic: input.topic,
              ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
            },
          })
          .catch(() => null);
        extracted = { summary: "", findings: [] };
        if (summary && "summary" in summary) {
          brief =
            summary.key_points.length > 0
              ? `${summary.summary}\n\n${summary.key_points
                  .map((p) => `- ${p}`)
                  .join("\n")}`
              : summary.summary;
        } else {
          brief = "";
          ctx.logger.info("pipeline-research.no_enrichment", {
            hint: "no local LLM and no enrichment provider — research brief skipped",
          });
        }
      }

      const memories: PipelineMemory[] = [];

      // Brief memory — skip when there's nothing to write (no LLM
      // and no enrichment provider answered).
      if (brief.trim().length > 0) {
        memories.push({
          content: brief.trim(),
          metadata: {
            ...baseMetadata,
            source_id: `${baseMetadata.source_id}#brief`,
            title: `Reference: ${input.topic}`,
          },
        });
      }

      // Finding memories (one each, capped).
      const findings = (extracted.findings ?? []).slice(0, maxFindings);
      const seen = new Set<string>();
      let emittedFinding = 0;
      for (const finding of findings) {
        const statement = (finding.statement ?? "").trim();
        if (!statement) continue;
        const key = statement.toLowerCase().replace(/\s+/g, " ").slice(0, 200);
        if (seen.has(key)) continue;
        seen.add(key);

        const citationsBlock = (finding.citations ?? [])
          .slice(0, 5)
          .map((c) => `- ${c.title ?? c.sourceId}`)
          .join("\n");

        const body = citationsBlock
          ? `${statement}\n\nCitations:\n${citationsBlock}`
          : statement;

        memories.push({
          content: body,
          metadata: {
            ...baseMetadata,
            source_id: `${baseMetadata.source_id}#finding-${emittedFinding}`,
            title: statement.slice(0, 120),
          },
        });
        emittedFinding++;
      }

      return memories;
    },
  };
}

function buildBaseMetadata(
  input: ResearchInput,
  topicSlug: string,
  traceId: string | undefined,
): MemoryMetadata {
  const project: string | string[] = input.projects
    ? input.projects.length === 1
      ? input.projects[0]!
      : input.projects
    : [];
  return {
    domain: "work",
    // Reference memories are synthesized from the user's own
    // retrieved context — there's no external source. "notion" is the
    // closest stand-in for a curated surface; retrieval filters on
    // `type: reference` + `tags: topic:*` so the source value doesn't
    // collide with actual Notion ingest.
    source: "notion",
    source_id: `cortex:research:${topicSlug}`,
    source_url: `cortex://research/${encodeURIComponent(topicSlug)}`,
    project,
    type: "reference",
    people: input.requesterSlug ? [input.requesterSlug] : [],
    date: new Date().toISOString(),
    confidence: 0.85,
    // Research output is unvetted until explicitly approved — see
    // the `approve_research` tool.
    sensitivity: "internal",
    trust: "experimental",
    status: "draft",
    tags: [`topic:${topicSlug}`],
    ...(traceId ? { trace_id: traceId } : {}),
  };
}

function normalizeTopic(topic: string): string {
  const cleaned = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80);
  if (cleaned.length > 0) return cleaned;
  // Degenerate input — use a hash so we don't collide on "".
  return createHash("sha256").update(topic).digest("hex").slice(0, 12);
}

function buildExtractPrompt(
  input: ResearchInput,
  maxItemChars: number,
): string {
  const lines: string[] = [
    "You extract factual findings from retrieved context to help answer a research question.",
    "Return STRICT JSON matching this schema. No prose, no ```fences.",
    "",
    "```json",
    '{ "summary": "one-sentence summary", "findings": [',
    '  { "statement": "single fact as a complete sentence",',
    '    "confidence": 0.0-1.0,',
    '    "citations": [{ "sourceId": "…", "title": "…" }] }',
    "] }",
    "```",
    "",
    "Rules:",
    "- Only include findings supported by the retrieved context.",
    "- No hallucinated sourceIds. If the fact has no citation, omit `citations`.",
    "- Deduplicate: merge findings that state the same thing with different wording.",
    "- Keep each `statement` under 180 characters.",
    "",
    `TOPIC: ${input.topic}`,
    "",
    "RETRIEVED CONTEXT:",
  ];
  if (input.retrievedContext.length === 0) {
    lines.push("(none — answer with empty findings array if you lack grounding)");
  } else {
    for (const [i, item] of input.retrievedContext.entries()) {
      lines.push("");
      lines.push(`--- context[${i}] sourceId=${item.sourceId} ---`);
      if (item.title) lines.push(`TITLE: ${item.title}`);
      if (item.date) lines.push(`DATE: ${item.date}`);
      if (item.url) lines.push(`URL: ${item.url}`);
      lines.push("");
      lines.push(item.content.slice(0, maxItemChars));
    }
  }
  return lines.join("\n");
}

function buildBriefPrompt(
  input: ResearchInput,
  extracted: ResearchExtracted,
): string {
  return [
    "Write a reference brief in markdown. Optimize for an ADHD reader:",
    "front-load the punchline, use short bullets, cite sources inline",
    "with the source title. Keep it under 400 words.",
    "",
    "Structure:",
    "```",
    "# <topic>",
    "",
    "## TL;DR",
    "(3-5 bullets with the most important findings.)",
    "",
    "## Key findings",
    "(Numbered list of the extracted findings with brief explanation.",
    " Cite source titles inline in italics.)",
    "",
    "## Open questions",
    "(Things the retrieved context couldn't answer. Empty if none.)",
    "",
    "## Further reading",
    "(Bulleted list of source titles that would be useful to read directly.)",
    "```",
    "",
    "Rules:",
    "- Never claim anything that isn't in the findings list.",
    "- If the findings list is empty, say so plainly in TL;DR and leave",
    "  the other sections empty instead of inventing content.",
    "- No preamble before the title. No postscript.",
    "",
    `TOPIC: ${input.topic}`,
    "",
    "EXTRACTED (pass 1 output):",
    JSON.stringify(extracted, null, 2),
  ].join("\n");
}

function parseJsonLoose<T>(raw: string): T | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;
  const fenceMatch = fence.exec(trimmed);
  const candidate = fenceMatch?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
