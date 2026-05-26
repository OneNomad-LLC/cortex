import type { LLMRouter } from "@onenomad/przm-cortex-llm-core";
import type { Logger } from "@onenomad/przm-cortex-core";

/**
 * LLM-driven extraction of structured items from a chunk of text. Runs
 * one completion against the configured `extract` task (or falls back
 * to `default`) and parses the JSON response into action items,
 * decisions, and entities.
 *
 * Why this lives outside the pipeline-* packages: the pipeline-doc /
 * -conversation / -meeting packages today only do mechanical chunking;
 * extending each one with its own LLM extractor would duplicate prompt
 * + parsing logic. One shared extractor here, the hook in
 * `ingest_content` decides when to call it based on content type.
 *
 * Output shape is intentionally compact (string fields only) so the
 * caller can persist each item as its own memory without worrying
 * about deep object metadata. Owner / due date / project are kept
 * as strings; the caller derives slugs + ISO dates downstream.
 *
 * Cost discipline: one LLM call per ingest, max ~700 tokens out.
 * At gpt-4o-mini Azure pricing ≈ $0.0002 per chunk.
 */

const SYSTEM_PROMPT = `You extract structured items from work content (notes, meeting transcripts, conversations, design docs).

Return a single JSON object with three arrays:
- actionItems: { description: string, owner?: string, due?: string, priority?: "P0"|"P1"|"P2" }[]
- decisions:   { summary: string, context?: string }[]
- entities:    { name: string, kind: "person"|"project"|"product"|"company"|"event" }[]

Rules:
- Only emit items the text explicitly states or strongly implies. Don't invent.
- Skip items already known to be done (past tense without forward-looking commitment).
- For action items: owner is a person mentioned by name (or "self" / "I" / "me" → "self"). due is an ISO date or natural language date if mentioned. priority only when explicit.
- For decisions: summary is one short sentence. context optional.
- For entities: extract names that show up multiple times or anchor the discussion. Skip generic terms.
- If a section has nothing structured to extract, return empty arrays. Empty is better than fabricated.

Output: just the JSON, no markdown fence, no commentary.`;

export interface ActionItem {
  description: string;
  owner?: string;
  due?: string;
  priority?: "P0" | "P1" | "P2";
}

export interface Decision {
  summary: string;
  context?: string;
}

export interface Entity {
  name: string;
  kind: "person" | "project" | "product" | "company" | "event";
}

export interface ExtractedItems {
  actionItems: ActionItem[];
  decisions: Decision[];
  entities: Entity[];
}

const EMPTY: ExtractedItems = { actionItems: [], decisions: [], entities: [] };

export interface ExtractStructuredItemsArgs {
  content: string;
  llmRouter: LLMRouter;
  logger: Logger;
  /** Trace id for correlating logs across the ingest + extraction. */
  traceId?: string;
  /**
   * Hard ceiling on chunk size to send to the LLM. Anything larger gets
   * truncated; we want bounded cost per call. The local Xenova chunker
   * already keeps cortex chunks below ~2KB so this is rarely a tail.
   */
  maxInputChars?: number;
}

export async function extractStructuredItems(
  args: ExtractStructuredItemsArgs,
): Promise<ExtractedItems> {
  const maxChars = args.maxInputChars ?? 4096;
  const trimmed =
    args.content.length > maxChars
      ? args.content.slice(0, maxChars) + "\n\n[truncated]"
      : args.content;

  // Skip extraction on tiny chunks — not worth the LLM call.
  if (trimmed.trim().length < 80) return EMPTY;

  let response: { content: string };
  try {
    response = await args.llmRouter.complete({
      task: "extract",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: trimmed },
      ],
      // Keep output tight — extraction over a chunk shouldn't sprawl.
      maxTokens: 800,
      temperature: 0,
    });
  } catch (err) {
    args.logger.warn("enrichment.extract.llm_failed", {
      error: err instanceof Error ? err.message : String(err),
      traceId: args.traceId,
      contentChars: trimmed.length,
    });
    return EMPTY;
  }

  // Strip a wrapping ```json fence if the model put one in despite the
  // prompt — tolerant parser, garbage in → return empty.
  const cleaned = response.content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    args.logger.warn("enrichment.extract.parse_failed", {
      error: err instanceof Error ? err.message : String(err),
      traceId: args.traceId,
      preview: cleaned.slice(0, 200),
    });
    return EMPTY;
  }

  return normalize(parsed);
}

function normalize(raw: unknown): ExtractedItems {
  if (!raw || typeof raw !== "object") return EMPTY;
  const obj = raw as Record<string, unknown>;
  return {
    actionItems: normalizeActionItems(obj.actionItems),
    decisions: normalizeDecisions(obj.decisions),
    entities: normalizeEntities(obj.entities),
  };
}

function normalizeActionItems(raw: unknown): ActionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ActionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const description = typeof o.description === "string" ? o.description.trim() : "";
    if (!description) continue;
    const action: ActionItem = { description };
    if (typeof o.owner === "string" && o.owner.trim().length > 0) {
      action.owner = o.owner.trim();
    }
    if (typeof o.due === "string" && o.due.trim().length > 0) {
      action.due = o.due.trim();
    }
    if (o.priority === "P0" || o.priority === "P1" || o.priority === "P2") {
      action.priority = o.priority;
    }
    out.push(action);
  }
  return out;
}

function normalizeDecisions(raw: unknown): Decision[] {
  if (!Array.isArray(raw)) return [];
  const out: Decision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const summary = typeof o.summary === "string" ? o.summary.trim() : "";
    if (!summary) continue;
    const decision: Decision = { summary };
    if (typeof o.context === "string" && o.context.trim().length > 0) {
      decision.context = o.context.trim();
    }
    out.push(decision);
  }
  return out;
}

function normalizeEntities(raw: unknown): Entity[] {
  if (!Array.isArray(raw)) return [];
  const out: Entity[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!name) continue;
    const kind = o.kind;
    if (
      kind !== "person" &&
      kind !== "project" &&
      kind !== "product" &&
      kind !== "company" &&
      kind !== "event"
    ) {
      continue;
    }
    out.push({ name, kind });
  }
  return out;
}

/**
 * Slugify a free-text name into a stable identifier suitable for
 * `owner:<slug>` tags or `sourceId` suffixes. Lowercase, alphanumeric +
 * hyphens, max 40 chars. Caller is responsible for deduping against the
 * workspace's people / projects taxonomy.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
