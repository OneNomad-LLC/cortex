import type { PipelineContext } from "./pipeline.js";

/**
 * Signals extracted from free-form content that power retrieval
 * filtering (due_date, urgency, mentions_me, owner). Every field is
 * optional — the extractor returns only what it's confident about
 * rather than hallucinating dates.
 */
export interface ExtractedSignals {
  due_date?: string | undefined;
  urgency?: "high" | "medium" | "low" | undefined;
  mentions_me?: boolean | undefined;
  owner?: string | undefined;
}

export interface ExtractSignalsOptions {
  /**
   * Anchor date for relative-phrase resolution ("tomorrow", "by
   * Friday"). Usually the memory's `date` field — the content's own
   * timestamp, not now(). Passed as an ISO string.
   */
  anchorIso: string;
  /**
   * Name + slug + aliases for the Cortex user. Mentions are flagged
   * via case-insensitive substring match. Empty array disables
   * mentions_me detection (leaving the field undefined).
   */
  selfAliases: readonly string[];
  /**
   * Known people slug → names/aliases map. Lets the extractor prefer
   * canonical slugs when reporting `owner`. Optional; unknown owners
   * are returned as the raw phrase when nothing matches.
   */
  peopleByAlias?: ReadonlyMap<string, string>;
  /** Task id to route the LLM call to. Default: "classify". */
  task?: string;
}

const SYSTEM = `You extract scheduling + attention signals from work \
content (meeting transcripts, chat threads, notes). Output strict \
JSON. Be conservative — if a field isn't clearly supported by the \
content, omit it. Never invent dates.

Fields:
- due_date: ISO 8601 date (YYYY-MM-DD) resolved from any deadline \
phrase in the content. Resolve relative phrases ("tomorrow", "next \
Friday", "EOW", "end of sprint") against the <anchor> date. Omit if \
no deadline is mentioned.
- urgency: "high" | "medium" | "low". High = explicit deadline <=48h, \
escalation phrasing ("blocker", "ASAP", "critical"). Medium = implied \
soon-ish. Low = informational/FYI. Omit if nothing suggests urgency.
- mentions_me: true when any of the <self_aliases> appears in the \
content (case-insensitive). False only when you checked and found no \
match. Omit if self_aliases is empty.
- owner: the person the content attributes ownership to ("Alex will…", \
"@jane owns"). Use the literal name/handle; the caller canonicalizes.
`;

/**
 * Single-call signal extractor. Returns an object with only the
 * fields confidently extracted. Failures (LLM errors, parse
 * failures) are logged and yield an empty result rather than
 * crashing the pipeline — signal extraction is best-effort.
 */
export async function extractSignals(
  content: string,
  ctx: PipelineContext,
  opts: ExtractSignalsOptions,
): Promise<ExtractedSignals> {
  const aliasesLine =
    opts.selfAliases.length > 0
      ? opts.selfAliases.join(", ")
      : "(none — leave mentions_me unset)";

  const prompt = [
    `<anchor>${opts.anchorIso}</anchor>`,
    `<self_aliases>${aliasesLine}</self_aliases>`,
    `<content>`,
    content.length > 12_000 ? `${content.slice(0, 12_000)}\n…` : content,
    `</content>`,
    "",
    "Return ONLY a JSON object. No prose. Example of shape:",
    `{"due_date":"2026-05-01","urgency":"high","mentions_me":true,"owner":"alex"}`,
    `Omit any field you aren't confident about.`,
  ].join("\n");

  // Cortex 0.2 — signal extraction is LLM-only; without one it's
  // a no-op. Pipelines that need temporal/owner signals from raw
  // content will need a connected enrichment provider; the queue
  // path doesn't currently flow through this extractor.
  if (!ctx.llm) {
    return {};
  }

  let raw: string;
  try {
    raw = await ctx.llm.complete({
      task: opts.task ?? "classify",
      system: SYSTEM,
      prompt,
      temperature: 0,
      maxTokens: 400,
      signal: ctx.signal,
    });
  } catch (err) {
    ctx.logger.warn("signal_extractor.llm_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }

  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    ctx.logger.warn("signal_extractor.parse_failed", {
      sample: raw.slice(0, 120),
    });
    return {};
  }

  const out: ExtractedSignals = {};

  if (typeof parsed.due_date === "string") {
    const iso = toIso(parsed.due_date);
    if (iso) out.due_date = iso;
  }

  if (
    parsed.urgency === "high" ||
    parsed.urgency === "medium" ||
    parsed.urgency === "low"
  ) {
    out.urgency = parsed.urgency;
  }

  if (opts.selfAliases.length > 0 && typeof parsed.mentions_me === "boolean") {
    out.mentions_me = parsed.mentions_me;
  }

  if (typeof parsed.owner === "string" && parsed.owner.trim().length > 0) {
    const raw = parsed.owner.trim();
    const canonical = canonicalizeOwner(raw, opts.peopleByAlias);
    if (canonical) out.owner = canonical;
  }

  return out;
}

/** LLMs occasionally wrap JSON in code fences or add prose. Tolerate. */
function parseJsonLoose(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : trimmed;
  // Grab the outermost object if prose preceded it.
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) return undefined;
  try {
    return JSON.parse(body.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toIso(raw: string): string | undefined {
  // Accept "2026-05-01" (date-only) or full ISO. Date-only normalizes
  // to midnight UTC so it passes the datetime({offset:true}) schema.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00+00:00`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function canonicalizeOwner(
  raw: string,
  peopleByAlias: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!peopleByAlias || peopleByAlias.size === 0) return raw;
  const norm = raw.toLowerCase().replace(/^@/, "").trim();
  const hit = peopleByAlias.get(norm);
  return hit ?? raw;
}
