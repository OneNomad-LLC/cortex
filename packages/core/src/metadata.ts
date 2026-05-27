import { z } from "zod";

/**
 * Runtime validator for the memory metadata contract. Adapters and
 * pipelines should validate before calling Engram.
 *
 * Authoritative JSON Schema lives at `schemas/memory-metadata.json` — keep
 * the two in sync when adding fields.
 */
export const memoryMetadataSchema = z.object({
  /** Always "work" for Cortex-ingested memories. */
  domain: z.literal("work"),
  source: z.enum([
    "loom",
    "google_meet",
    "confluence",
    "notion",
    "google_drive",
    "jira",
    "linear",
    "bitbucket",
    "github",
    "calendar",
    "slack",
    "teams",
    "email",
    "obsidian",
    "manual",
  ]),
  /** Stable identifier from the source. Used for idempotent ingestion. */
  source_id: z.string().min(1),
  source_url: z.string().url(),
  /** Project slug or list of slugs from config/projects.yaml.
   *  Phase 1D (2026-05-09): now optional. Multi-tenant knowledge-engine
   *  chunks live in the workspace; project is just an optional sub-tag
   *  for callers who curate their own taxonomy. ingest_content omits
   *  it when the sentinel "default" project is in use. */
  project: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  // `type` is intentionally an open string here. The closed list lived
  // at this layer until 0.4 — but customer-extensible taxonomy means
  // the canonical built-in set isn't the whole truth. Validation now
  // happens against a live `MemoryTypeRegistry` at the ingest boundary,
  // which merges built-ins with per-workspace `customTypes` and auto-
  // registers anything an LLM classifier emits (normalized first).
  // See `packages/core/src/memory-types.ts` for the registry and
  // `BUILT_IN_MEMORY_TYPES` for the canonical set.
  type: z.string().min(1),
  /** Person slugs from config/people.yaml. May be empty. */
  people: z.array(z.string()),
  /** ISO 8601 timestamp of the content itself, not ingestion time. */
  date: z.string().datetime({ offset: true }),
  /** 0-1. Low values flag the memory for review. */
  confidence: z.number().min(0).max(1),
  title: z.string().optional(),
  parent_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * Correlation id set at the entry point of the operation that produced
   * this memory (MCP tool call, scheduled sync run, manual CLI sync).
   * Lets an operator trace "why does this memory exist" back through the
   * ingestion pipeline in one search.
   */
  trace_id: z.string().optional(),
  /**
   * Sensitivity label — governs how broadly a memory can surface. Defaults
   * come from the source type (see `defaultTrustForSource`) and can be
   * overridden per-memory by the adapter / user.
   */
  sensitivity: z
    .enum(["public", "internal", "confidential", "restricted"])
    .optional(),
  /**
   * Trust bucket. Separate from `sensitivity` — answers "how reliable is
   * this content" rather than "who may see it".
   *
   *   - "approved"     curated / signed-off reference material
   *   - "experimental" raw ingest, not vetted (most adapter output lands here)
   *   - "external"     third-party content; treat as untrusted input
   */
  trust: z.enum(["approved", "experimental", "external"]).optional(),
  /**
   * Lifecycle status for curation-worthy memories (reference briefs,
   * decisions, action items). Ordinary ingested content leaves this unset.
   */
  status: z
    .enum(["draft", "in_review", "approved", "revoked"])
    .optional(),
  /**
   * Client-engagement context. Forms a 3-level hierarchy with `sub_brand`
   * and `project` — e.g. engagement="driven-brands", sub_brand="jiffy-lube",
   * project="rebrand-2026". All optional; individual users and org-wide
   * memories leave them unset. See ADR-014 (toolkit + engagement model).
   */
  engagement: z.string().min(1).optional(),
  /** Sub-brand slug within an engagement (client multi-brand rollups). */
  sub_brand: z.string().min(1).optional(),
  /** Release tag or version this memory belongs to (e.g. "v2.3"). */
  release: z.string().min(1).optional(),
  /**
   * Dev team slug. Cross-cuts engagements — the same team often works
   * across multiple clients, so team is tagged independently of
   * engagement. Used by capacity / standup / cross-engagement views.
   */
  team: z.string().min(1).optional(),
  /**
   * Extracted due date (ISO 8601). Set by the temporal-extractor
   * pipeline step when the content contains time-bound phrases
   * ("by Friday", "tomorrow", "EOW") — relative phrases are
   * resolved against `date` above. Absent when no deadline is
   * discernible; retrieval tools treat absent as open-ended.
   */
  due_date: z.string().datetime({ offset: true }).optional(),
  /**
   * Urgency bucket derived from the content's tone/phrasing. High =
   * explicit deadline or escalation language; medium = implied
   * deadline; low = informational. Unset when nothing in the
   * content suggests urgency.
   */
  urgency: z.enum(["high", "medium", "low"]).optional(),
  /**
   * True when the content mentions the Cortex user (by slug, name,
   * email, or an alias). Resolved by comparing against the person
   * flagged `self: true` in people.yaml. Powers `needs_my_attention`
   * and boosts in todays_digest.
   */
  mentions_me: z.boolean().optional(),
  /**
   * The owner slug when the content attributes work to someone
   * specific ("Alex will…", "@jane owns…"). Unset when ownership
   * is ambiguous or absent.
   */
  owner: z.string().min(1).optional(),
  /**
   * Cortex workspace slug this memory belongs to. Stamped at ingest
   * time from the session's bound workspace. Retrieval tools filter
   * on this so content from a "work" workspace doesn't bleed into a
   * "personal" session. Missing on memories ingested before the
   * session-scoping rollout — callers treat the absence as
   * "belongs to any workspace" (backwards compat).
   */
  workspace: z.string().min(1).optional(),
  /**
   * LLM-generated concise gist of the memory's content. Produced by
   * the summary extractor at ingest time (ADR-020). Absent when the
   * extractor is disabled or not yet run. Both the tsvector column
   * and the embedding compose this in when present.
   */
  summary: z.string().optional(),
  /**
   * LLM-extracted domain terms, acronyms, and jargon from the content.
   * Produced by the keywords extractor at ingest time (ADR-020). Empty
   * or absent when the extractor is disabled. Indexed into the tsvector
   * column and the embedding so domain-specific terms surface on both
   * BM25 and vector channels.
   */
  keywords: z.array(z.string()).optional(),
});

export type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;
