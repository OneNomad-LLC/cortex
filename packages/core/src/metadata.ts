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
  /** Project slug or list of slugs from config/projects.yaml. */
  project: z.union([z.string().min(1), z.array(z.string().min(1))]),
  type: z.enum([
    "meeting",
    "decision",
    "action_item",
    "doc",
    "code",
    "note",
    "brief",
    "digest",
    "conversation",
    "commit",
    "event",
    "reference",
    // Cross-session handoffs — written by one Claude surface, read by
    // the next so conversations survive a context switch.
    "session_handoff",
  ]),
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
});

export type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;
