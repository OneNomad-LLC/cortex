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
});

export type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;
