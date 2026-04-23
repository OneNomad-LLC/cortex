/**
 * Canonical source identifiers. Adapters declare their id here so metadata
 * is consistent across the system.
 */
export type SourceType =
  // Meetings / recordings
  | "loom"
  | "google_meet"
  // Docs / wiki
  | "confluence"
  | "notion"
  | "google_drive"
  // Tickets / issues
  | "jira"
  | "linear"
  // Code
  | "bitbucket"
  | "github"
  // Calendars
  | "calendar" // google calendar (legacy id; kept for back-compat)
  // Chat / conversation
  | "slack"
  | "teams"
  // Mail
  | "email"
  // Personal notes
  | "obsidian"
  // Manually imported via `cortex import meeting` / MCP tool — used when
  // the content came from a file the user dropped in, not an adapter.
  | "manual";

/**
 * Canonical content types. Pipelines route on these.
 */
export type ContentType =
  | "meeting"
  | "decision"
  | "action_item"
  | "doc"
  | "code"
  | "note"
  | "brief"
  | "digest"
  | "conversation"
  | "commit"
  | "event"
  | "reference";

/**
 * A file/link attached to a normalized item. Optional; not every source has
 * attachments worth preserving.
 */
export interface Attachment {
  /** Stable identifier within the source (e.g., filename or asset id). */
  id: string;
  /** Human-readable label. */
  name: string;
  /** MIME type where known, otherwise empty string. */
  mimeType: string;
  /** Download URL or filesystem path. */
  url: string;
  /** Size in bytes if known. */
  sizeBytes?: number;
}

/**
 * Output of `adapter.transform()`. Every adapter produces this shape so
 * pipelines and classifiers can stay source-agnostic.
 */
export interface NormalizedItem {
  /** Stable id from the source. Used as the idempotency key. */
  sourceId: string;
  sourceType: SourceType;
  /** Canonical link back to the original content. */
  sourceUrl: string;
  title: string;
  /** Markdown or plain text. Treat as the primary content. */
  content: string;
  contentType: ContentType;
  createdAt: Date;
  updatedAt: Date;
  /** Person slugs resolved via `config/people.yaml`. Unknowns dropped. */
  authors: string[];
  /** For hierarchical content (Confluence child pages, comments, etc.). */
  parentId?: string;
  attachments?: Attachment[];
  /** Source-specific extras. Preserved verbatim for later reference. */
  rawMetadata: Record<string, unknown>;
}

/**
 * Output of `adapter.classify()`. Enriches a NormalizedItem with project
 * tags and a confidence score.
 */
export interface ClassifiedItem extends NormalizedItem {
  /** Project slugs from `config/projects.yaml`. May be empty (review queue). */
  projects: string[];
  /** 0-1. Low values flagged for manual review. */
  confidence: number;
  classificationMethod:
    | "attendee-match"
    | "content-llm"
    | "rule"
    | "path-based"
    | "manual";
  /**
   * Client-engagement context. Optional — set by adapters that can derive
   * it from their source (per-space mapping for Confluence, per-project for
   * Jira, per-repo for GitHub, etc.). Pipeline-* stamps these onto every
   * emitted memory when present. See `memoryMetadataSchema` for the
   * hierarchy shape and ADR-014 for rationale.
   */
  engagement?: string;
  subBrand?: string;
  release?: string;
  team?: string;
}

/**
 * Opaque raw shape coming out of a source API. Adapters narrow this to their
 * own types internally; the public surface just preserves it through
 * `fetch()` -> `transform()`.
 */
export interface RawSourceItem {
  readonly sourceId: string;
  readonly raw: unknown;
}

/**
 * Health status reported by adapters, providers, and upstream MCP clients.
 */
export interface HealthStatus {
  healthy: boolean;
  /** Short human-readable message. Empty string when healthy. */
  message: string;
  /** Unix ms timestamp of the last successful call, if any. */
  lastSuccessAt?: number;
  /** Free-form details for logging. */
  details?: Record<string, unknown>;
}
