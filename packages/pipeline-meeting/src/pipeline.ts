import { defaultTrustForSource } from "@onenomad/cortex-core";
import type {
  ClassifiedItem,
  MemoryMetadata,
  SourceType,
} from "@onenomad/cortex-core";
import {
  extractSignals,
  type ExtractedSignals,
  type Pipeline,
  type PipelineContext,
  type PipelineMemory,
} from "@onenomad/cortex-pipeline-core";
import { loadPrompt, renderPrompt } from "./prompts.js";
import {
  meetingStructuredSchema,
  type MeetingPipelineOptions,
  type MeetingStructured,
} from "./types.js";

export function createMeetingPipeline(
  opts: MeetingPipelineOptions = {},
): Pipeline<ClassifiedItem, PipelineMemory> {
  const {
    chunkSize = 2_500,
    includeBrief = true,
    includeDecisionMemories = true,
    includeActionItemMemories = true,
    includeTranscriptChunks = true,
    maxSubMemories = 50,
    priorDecisions = "[]",
    peopleContext = "[]",
  } = opts;

  return {
    id: "@onenomad/cortex-pipeline-meeting",
    version: "0.1.0",

    async run(
      input: ClassifiedItem,
      ctx: PipelineContext,
    ): Promise<PipelineMemory[]> {
      const memories: PipelineMemory[] = [];
      const baseMeta = buildBaseMetadata(input, ctx.traceId);

      // Extract temporal + attention signals from the transcript
      // before the multi-pass structural extraction. Runs in parallel
      // with Pass 1 since neither depends on the other. Log on failure
      // so silent signal loss is visible in the pipeline trace.
      const signalsPromise = extractSignals(input.content, ctx, {
        anchorIso: input.updatedAt.toISOString(),
        selfAliases: ctx.selfAliases ?? [],
        ...(ctx.peopleByAlias ? { peopleByAlias: ctx.peopleByAlias } : {}),
      }).catch((err: unknown) => {
        ctx.logger.warn("pipeline-meeting.signals.failed", {
          traceId: ctx.traceId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {} as ExtractedSignals;
      });

      // Cortex 0.2 — when no local LLM is configured, the meeting
      // pipeline can't do its 3-pass structured extraction in
      // process. We fall back to the Cortex Enrichment Protocol:
      // ask the connected MCP client (Pyre, Claude Desktop) to
      // produce a summary + extracted actions, and stitch those
      // into the same memory shape. If neither LLM nor enrichment
      // callback is present, store raw transcript chunks only.
      let structured: MeetingStructured;
      let synthesized: MeetingStructured;
      let brief: string;

      if (ctx.llm) {
        // --- Pass 1: structural -----------------------------------
        const pass1Tmpl = await loadPrompt("pass1-structural.md");
        const pass1Prompt = renderPrompt(pass1Tmpl, {
          TRANSCRIPT: input.content,
        });
        const pass1Raw = await ctx.llm.complete({
          task: "structural",
          prompt: pass1Prompt,
          temperature: 0,
          maxTokens: 2048,
        });
        structured = parseAndValidate(
          pass1Raw,
          ctx,
          "pipeline-meeting.pass1.invalid_shape",
        );

        // --- Pass 2: synthesis ------------------------------------
        const pass2Tmpl = await loadPrompt("pass2-synthesis.md");
        const pass2Prompt = renderPrompt(pass2Tmpl, {
          PEOPLE_CONTEXT: peopleContext,
          PRIOR_DECISIONS: priorDecisions,
          MEETING_DATE: input.updatedAt.toISOString(),
          STRUCTURED_INPUT: JSON.stringify(structured, null, 2),
        });
        const pass2Raw = await ctx.llm.complete({
          task: "synthesis",
          prompt: pass2Prompt,
          temperature: 0,
          maxTokens: 2048,
        });
        synthesized = parseAndValidate(
          pass2Raw,
          ctx,
          "pipeline-meeting.pass2.invalid_shape",
        );

        // --- Pass 3: brief ----------------------------------------
        const pass3Tmpl = await loadPrompt("pass3-brief.md");
        const pass3Prompt = renderPrompt(pass3Tmpl, {
          TITLE: input.title,
          DATE: input.updatedAt.toISOString().slice(0, 10),
          PARTICIPANTS:
            (synthesized.participants ?? []).map((p) => p.name).join(", ") ||
            "unknown",
          SYNTHESIZED_INPUT: JSON.stringify(synthesized, null, 2),
        });
        brief = await ctx.llm.complete({
          task: "brief",
          prompt: pass3Prompt,
          temperature: 0.2,
          maxTokens: 2048,
        });
      } else {
        // No local LLM. Ask the enrichment callback for a summary +
        // action extraction in parallel; both are best-effort.
        const summarizePromise = ctx.enrichment
          ?.enrich({
            type: "summarize",
            payload: { content: input.content, hint: input.title },
            context: {
              source: input.sourceType,
              source_id: input.sourceId,
              ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
            },
          })
          .catch(() => null);
        const actionsPromise = ctx.enrichment
          ?.enrich({
            type: "extract_actions",
            payload: { content: input.content, source: input.sourceId },
            context: {
              source: input.sourceType,
              source_id: input.sourceId,
              ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
            },
          })
          .catch(() => null);

        const [summary, actions] = await Promise.all([
          summarizePromise ?? Promise.resolve(null),
          actionsPromise ?? Promise.resolve(null),
        ]);

        const empty = meetingStructuredSchema.parse({});
        structured = empty;
        // Re-parse through the schema so the action_items shape matches
        // exactly (zod fills nullable fields with null, etc.).
        synthesized = meetingStructuredSchema.parse({
          ...empty,
          ...(actions && "actions" in actions
            ? {
                action_items: actions.actions.map((a) => ({
                  description: a.description,
                  owner: a.assignee ?? null,
                  due_hint: null,
                  due_date: a.due ?? null,
                })),
              }
            : {}),
        });
        brief =
          summary && "summary" in summary
            ? summary.key_points.length > 0
              ? `${summary.summary}\n\n${summary.key_points
                  .map((p) => `- ${p}`)
                  .join("\n")}`
              : summary.summary
            : ""; // empty brief when neither LLM nor enrichment gave us anything
        if (!brief) {
          ctx.logger.info("pipeline-meeting.no_enrichment", {
            hint: "no local LLM and no enrichment provider — storing raw transcript chunks only",
          });
        }
      }

      // Wait for the signal extractor (kicked off before Pass 1) and
      // merge its findings into baseMeta before emission so every
      // sub-memory inherits them.
      const signals = await signalsPromise;
      applySignals(baseMeta, signals);

      // --- Emit memories --------------------------------------------
      // Empty brief = no LLM and no enrichment callback. Skip the
      // brief memory rather than emitting an empty string.
      if (includeBrief && brief.trim().length > 0) {
        memories.push({
          content: brief.trim(),
          metadata: {
            ...baseMeta,
            source_id: `${input.sourceId}#brief`,
            type: "brief",
            title: `Brief: ${input.title}`,
          },
        });
      }

      if (includeDecisionMemories) {
        for (const [i, d] of (synthesized.decisions ?? [])
          .slice(0, maxSubMemories)
          .entries()) {
          const owner = d.owner ? `**${d.owner}:** ` : "";
          const rationale = d.rationale ? `\n\n_${d.rationale}_` : "";
          memories.push({
            content: `${owner}${d.statement}${rationale}`,
            metadata: {
              ...baseMeta,
              source_id: `${input.sourceId}#decision-${i}`,
              type: "decision",
              title: d.statement.slice(0, 120),
              ...(d.owner ? { tags: [`owner:${d.owner}`] } : {}),
            },
          });
        }
      }

      if (includeActionItemMemories) {
        for (const [i, a] of (synthesized.action_items ?? [])
          .slice(0, maxSubMemories)
          .entries()) {
          const owner = a.owner ? `**${a.owner}:** ` : "";
          const due = a.due_date
            ? ` _(due ${a.due_date})_`
            : a.due_hint
              ? ` _(${a.due_hint})_`
              : "";
          const tags: string[] = [];
          if (a.owner) tags.push(`owner:${a.owner}`);
          if (a.due_date) tags.push(`due:${a.due_date}`);
          memories.push({
            content: `- [ ] ${owner}${a.description}${due}`,
            metadata: {
              ...baseMeta,
              source_id: `${input.sourceId}#action-${i}`,
              type: "action_item",
              title: a.description.slice(0, 120),
              ...(tags.length > 0 ? { tags } : {}),
            },
          });
        }
      }

      if (includeTranscriptChunks) {
        const chunks = splitIntoChunks(input.content, chunkSize);
        for (const [i, chunk] of chunks.entries()) {
          memories.push({
            content: chunk,
            metadata: {
              ...baseMeta,
              source_id: `${input.sourceId}#chunk-${i}`,
              type: "meeting",
              title: `${input.title} (part ${i + 1}/${chunks.length})`,
            },
          });
        }
      }

      return memories;
    },
  };
}

/**
 * Merge signal-extractor output into a base metadata object in place.
 * Same shape as conversation pipeline — shared behavior, pulled out
 * to keep both pipelines aligned.
 */
function applySignals(meta: MemoryMetadata, signals: ExtractedSignals): void {
  if (signals.due_date) meta.due_date = signals.due_date;
  if (signals.urgency) meta.urgency = signals.urgency;
  if (signals.mentions_me !== undefined) meta.mentions_me = signals.mentions_me;
  if (signals.owner) meta.owner = signals.owner;
}

function buildBaseMetadata(
  input: ClassifiedItem,
  traceId: string | undefined,
): MemoryMetadata {
  const project: string | string[] =
    input.projects.length === 1 ? input.projects[0]! : input.projects;
  const trustDefaults = defaultTrustForSource(input.sourceType as SourceType);
  return {
    domain: "work",
    source: input.sourceType as SourceType,
    source_id: input.sourceId,
    source_url: input.sourceUrl,
    project,
    type: "meeting",
    people: input.authors,
    date: input.updatedAt.toISOString(),
    confidence: input.confidence,
    sensitivity: trustDefaults.sensitivity,
    trust: trustDefaults.trust,
    ...(input.title ? { title: input.title } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
  };
}

/**
 * Chunk a transcript by character count, breaking on paragraph
 * boundaries where possible. Good enough; caller-facing shapes don't
 * depend on sentence boundaries.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text.trim()].filter((s) => s.length > 0);
  const paragraphs = text.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = "";
  for (const para of paragraphs) {
    if (!buf) {
      buf = para;
      continue;
    }
    if (buf.length + para.length + 2 <= maxChars) {
      buf = `${buf}\n\n${para}`;
    } else {
      out.push(buf.trim());
      buf = para;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

/**
 * Parse an LLM JSON response + validate against the MeetingStructured
 * schema. On shape failures, log and return an empty structure so the
 * rest of the pipeline still produces a brief (downgraded quality,
 * not a lost meeting). Exported for tests.
 */
export function parseAndValidate(
  raw: string,
  ctx: PipelineContext,
  event: string,
): MeetingStructured {
  let parsed: unknown;
  try {
    parsed = parseJsonLoose<unknown>(raw);
  } catch (err) {
    ctx.logger.warn(event, {
      traceId: ctx.traceId,
      reason: "json_parse_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return meetingStructuredSchema.parse({});
  }
  const result = meetingStructuredSchema.safeParse(parsed);
  if (!result.success) {
    ctx.logger.warn(event, {
      traceId: ctx.traceId,
      reason: "schema_failed",
      issues: result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return meetingStructuredSchema.parse({});
  }
  return result.data;
}

/**
 * Parse JSON that may arrive wrapped in a ``` fence or with leading/trailing
 * prose despite our prompt instructions. Fall back to extracting the first
 * `{...}` block.
 */
export function parseJsonLoose<T>(raw: string): T {
  const trimmed = raw.trim();

  // Strip ``` or ```json fences.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;
  const fenceMatch = fence.exec(trimmed);
  const candidate = fenceMatch?.[1] ?? trimmed;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error(
      `pipeline-meeting: failed to parse JSON from LLM response (${candidate.slice(0, 120)}...)`,
    );
  }
}
