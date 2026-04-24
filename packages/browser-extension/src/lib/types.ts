/**
 * Shared types between content script, background service worker,
 * and popup. Kept in one file so the message contract is easy to
 * audit — add a new variant here before wiring the sender/receiver.
 */

/** Cortex canonical SourceType — matches ingest_content's source enum. */
export type CortexSource =
  | "manual"
  | "loom"
  | "google_meet"
  | "confluence"
  | "notion"
  | "google_drive"
  | "jira"
  | "linear"
  | "bitbucket"
  | "github"
  | "calendar"
  | "slack"
  | "teams"
  | "email"
  | "obsidian";

/** Cortex ingest content types. */
export type CortexType =
  | "doc"
  | "code"
  | "meeting"
  | "conversation"
  | "note"
  | "decision"
  | "brief"
  | "digest";

export type ExtractorSource = "slack" | "email" | "teams" | "manual";

export interface ExtractorResult {
  content: string;
  title: string;
  /** Where this originated — maps to our DOM extractor family. */
  source: ExtractorSource;
  /** Best-guess Cortex `type` given the shape of the content. */
  suggestedType: CortexType;
  /**
   * Stable-ish id used as the dedupe key in Engram. Re-ingesting with
   * the same sourceId updates instead of duplicating — see ingest_content.
   */
  sourceId: string;
  /** Canonical URL to round-trip back to the source. */
  sourceUrl: string;
}

/* Message contract: content ↔ background ↔ popup.
 *
 * A single discriminated union covers every direction. The
 * content script cares about `EXTRACT_*` (incoming) and
 * `INGEST_RESULT` (reflecting a background-driven ingest back in the
 * page toast); the background cares about `INGEST_*`. Kept as one
 * type so the message dispatcher in each endpoint gets exhaustive
 * checking.
 */

interface IngestSelectionMessage {
  type: "INGEST_SELECTION";
  content: string;
  url: string;
  title: string;
}

interface ExtractThreadMessage {
  type: "EXTRACT_THREAD";
}

interface ExtractPageMessage {
  type: "EXTRACT_PAGE";
}

interface IngestExtractedMessage {
  type: "INGEST_EXTRACTED";
  extracted: ExtractorResult;
  project?: string;
  cortexType?: CortexType;
  tags?: string[];
}

interface PingApiMessage {
  type: "PING_API";
  apiBase: string;
}

interface ExtractResultSuccess {
  type: "EXTRACT_RESULT";
  ok: true;
  result: ExtractorResult;
}

interface ExtractResultFailure {
  type: "EXTRACT_RESULT";
  ok: false;
  error: string;
}

interface IngestResultMessage {
  type: "INGEST_RESULT";
  ok: boolean;
  error?: string;
  count?: number;
}

export type InboundMessage =
  | IngestSelectionMessage
  | ExtractThreadMessage
  | ExtractPageMessage
  | IngestExtractedMessage
  | PingApiMessage
  | IngestResultMessage; // listened for by the content script so the
// background can tell it to show a toast.

export type OutboundMessage =
  | ExtractResultSuccess
  | ExtractResultFailure
  | IngestResultMessage;

export interface RecentIngest {
  sourceId: string;
  title: string;
  project: string;
  type: CortexType;
  sourceUrl: string;
  at: string; // ISO timestamp
}
