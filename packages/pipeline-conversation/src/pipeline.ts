import { defaultTrustForSource } from "@onenomad/przm-cortex-core";
import type {
  ClassifiedItem,
  MemoryMetadata,
  SourceType,
} from "@onenomad/przm-cortex-core";
import {
  extractSignals,
  type ExtractedSignals,
  type Pipeline,
  type PipelineContext,
  type PipelineMemory,
} from "@onenomad/przm-cortex-pipeline-core";
import { parseConversation, serializeConversation } from "./parse.js";

export interface ConversationPipelineOptions {
  /** Emit individual quote memories once the thread exceeds this count. */
  quoteEmitThreshold?: number;
  /** Max quote memories to emit per thread. */
  maxQuotes?: number;
  /** Split a thread into daily sub-memories when it spans more than this many days. */
  multiDaySplitThreshold?: number;
}

export function createConversationPipeline(
  opts: ConversationPipelineOptions = {},
): Pipeline<ClassifiedItem, PipelineMemory> {
  const quoteThreshold = opts.quoteEmitThreshold ?? 8;
  const maxQuotes = opts.maxQuotes ?? 12;
  const multiDaySplit = opts.multiDaySplitThreshold ?? 3;

  return {
    id: "@onenomad/przm-cortex-pipeline-conversation",
    version: "0.1.0",

    async run(
      input: ClassifiedItem,
      ctx: PipelineContext,
    ): Promise<PipelineMemory[]> {
      const messages = parseConversation(input.content);
      if (messages.length === 0) return [];

      const baseMeta = buildBaseMetadata(input, ctx.traceId);
      // Run the signal extractor once over the full thread. Result is
      // merged into every emitted memory so per-day + per-quote slices
      // inherit the same due_date / urgency / mentions_me / owner.
      const signals = ctx.llm
        ? await extractSignals(input.content, ctx, {
            anchorIso: input.updatedAt.toISOString(),
            selfAliases: ctx.selfAliases ?? [],
            ...(ctx.peopleByAlias ? { peopleByAlias: ctx.peopleByAlias } : {}),
          }).catch(() => ({} as ExtractedSignals))
        : ({} as ExtractedSignals);
      applySignals(baseMeta, signals);
      const memories: PipelineMemory[] = [];

      // 1. Thread-level memory (always emit).
      memories.push({
        content: serializeConversation(messages),
        metadata: {
          ...baseMeta,
          source_id: `${input.sourceId}#thread`,
          type: "conversation",
        },
      });

      // 2. Per-day sub-memories if the thread spans enough days.
      const daySpans = groupByDay(messages);
      if (daySpans.size > multiDaySplit) {
        let idx = 0;
        for (const [day, msgs] of daySpans) {
          memories.push({
            content: serializeConversation(msgs),
            metadata: {
              ...baseMeta,
              source_id: `${input.sourceId}#day-${idx}`,
              type: "conversation",
              title: `${input.title} — ${day}`,
            },
          });
          idx++;
        }
      }

      // 3. Per-message quote memories once a thread is busy enough.
      if (messages.length >= quoteThreshold) {
        const significant = pickSignificantMessages(messages, maxQuotes);
        for (const [i, msg] of significant.entries()) {
          memories.push({
            content: `**${msg.speaker}:** ${msg.text}`,
            metadata: {
              ...baseMeta,
              source_id: `${input.sourceId}#quote-${i}`,
              type: "note",
              title: `${msg.speaker}: ${msg.text.slice(0, 80)}`,
              tags: [`speaker:${msg.speaker}`],
            },
          });
        }
      }

      return memories;
    },
  };
}

/**
 * Mutate `meta` in place with the extractor's findings. Kept separate
 * so it can be reused across pipelines — same contract everywhere.
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
    type: "conversation",
    people: input.authors,
    date: input.updatedAt.toISOString(),
    confidence: input.confidence,
    sensitivity: trustDefaults.sensitivity,
    trust: trustDefaults.trust,
    ...(input.title ? { title: input.title } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
  };
}

function groupByDay(
  messages: ReturnType<typeof parseConversation>,
): Map<string, ReturnType<typeof parseConversation>> {
  const out = new Map<string, ReturnType<typeof parseConversation>>();
  for (const msg of messages) {
    const day = msg.timestampIso
      ? msg.timestampIso.slice(0, 10)
      : "unknown";
    const bucket = out.get(day);
    if (bucket) bucket.push(msg);
    else out.set(day, [msg]);
  }
  return out;
}

/**
 * Pick "quote-worthy" messages: longer-than-average lines, up to the cap.
 * Heuristic; no LLM. Retrieval-oriented — surfacing specific statements
 * beats one giant thread memory.
 */
function pickSignificantMessages(
  messages: ReturnType<typeof parseConversation>,
  cap: number,
): ReturnType<typeof parseConversation> {
  const scored = messages.map((m) => ({
    msg: m,
    score: m.text.length,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap).map((s) => s.msg);
}
