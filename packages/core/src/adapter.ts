import type { z } from "zod";
import type { AdapterCapabilities } from "./capabilities.js";
import type { AdapterContext, Logger } from "./context.js";
import type {
  ClassifiedItem,
  HealthStatus,
  NormalizedItem,
  RawSourceItem,
} from "./types.js";

/**
 * Classification can pull in more than just the item itself. This is the
 * slot for shared signals (attendee matches, path rules, etc.) that the
 * classifier may consult beyond the item body.
 */
export interface ClassificationContext {
  /** Hint from a rule-based first pass, if any. */
  ruleHint?: { projects: string[]; confidence: number };
  /** Free-form signals collected by the adapter (meeting attendees, etc.). */
  signals?: Record<string, unknown>;
}

/**
 * Injected into `adapter.stream()` for long-running watchers (file system,
 * websocket, etc.). Cancellation is signal-driven so the server can tear
 * down the watcher cleanly on shutdown.
 */
export interface StreamContext {
  signal: AbortSignal;
  logger: Logger;
}

/**
 * Opaque view of an incoming webhook. Providers sign differently (HMAC-
 * SHA256 for GitHub, HMAC-SHA1 for Slack legacy, JWT for some, nothing for
 * others), so we pass the raw material rather than pre-parsed JSON — the
 * adapter decides how to verify and parse.
 */
export interface WebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Raw request body as a UTF-8 string. Required for signature verification. */
  rawBody: string;
}

/**
 * Returned from `adapter.webhook()`. Adapters with webhooks mount a handler
 * at the declared path; the webhook receiver verifies, parses, then runs
 * each yielded RawSourceItem through the same transform → classify →
 * pipeline → ingest chain as scheduled sync.
 */
export interface WebhookHandler {
  /**
   * Path to mount at, e.g. "/webhooks/github". Leading slash required.
   * Paths are scoped per-adapter by the receiver, but the adapter owns
   * the full string so it can vary per event type if it wants.
   */
  path: string;
  /**
   * HTTP methods accepted. Default ["POST"]. GET is sometimes used for
   * provider-initiated challenge responses (Slack URL verification).
   */
  methods?: readonly string[];
  /**
   * Verify signature. Return `{ok: true}` to accept, `{ok: false, reason}`
   * to reject with a 401 (the reason is logged but never sent back — a
   * misconfigured attacker shouldn't learn which check failed).
   */
  verify(req: WebhookRequest): Promise<VerifyResult> | VerifyResult;
  /**
   * Parse a verified request into zero or more RawSourceItems. Returning
   * zero items is the right move for heartbeats / noise events; the
   * receiver responds 200 either way so the provider stops retrying.
   */
  parse(req: WebhookRequest): Promise<RawSourceItem[]> | RawSourceItem[];
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Injected into `adapter.webhook()` so the handler can log and share the
 * adapter's scoped logger.
 */
export interface WebhookContext {
  logger: Logger;
}

/**
 * Every source adapter implements this contract. Registered at startup;
 * scheduled by the server; invoked by the registry.
 *
 * Adapters are idempotent by `NormalizedItem.sourceId`. Re-running on the
 * same source content updates existing memories rather than duplicating.
 */
export interface SourceAdapter {
  /** Stable id, matches `SourceType`. Used as the metadata `source` field. */
  readonly id: string;
  /** Human-readable name for logs and UIs. */
  readonly name: string;
  /** Semver string, used for compatibility checks. */
  readonly version: string;

  /** Zod schema for this adapter's config block in cortex.yaml. */
  readonly configSchema: z.ZodTypeAny;
  /** Env var names this adapter needs. Registry verifies at startup. */
  readonly requiredSecrets: readonly string[];
  /** What the adapter can do. Affects scheduling and routing decisions. */
  readonly capabilities: AdapterCapabilities;
  /** Pipeline package ids this adapter's output should flow through. */
  readonly pipelines: readonly string[];

  /** Called once after construction. Any setup happens here. */
  init(ctx: AdapterContext): Promise<void>;
  /** Lightweight liveness probe. Should not touch external APIs heavily. */
  healthCheck(): Promise<HealthStatus>;
  /** Clean up resources. Called on server shutdown. */
  shutdown(): Promise<void>;

  /**
   * Yield new/changed items since `since`. Adapter owns cursor/pagination.
   * If `since` is omitted, yield everything (bounded by the adapter's
   * natural cap — e.g., Loom's "recent" window).
   */
  fetch(since?: Date): AsyncIterable<RawSourceItem>;

  /** Normalize a raw source item to the canonical shape. Pure. */
  transform(raw: RawSourceItem): Promise<NormalizedItem>;

  /** Tag with project slugs. See ClassificationContext for shared signals. */
  classify(
    item: NormalizedItem,
    ctx: ClassificationContext,
  ): Promise<ClassifiedItem>;

  /**
   * Optional long-running stream. The scheduler subscribes once at boot
   * and keeps the iterator open for the lifetime of the process, feeding
   * each yielded item through the same transform → classify → pipeline →
   * ingest chain as scheduled sync. Use this for filesystem watchers
   * (Obsidian), websocket streams (Slack events API), or any other
   * push-based source.
   *
   * Implementations must respect `ctx.signal` — when it aborts, the
   * iterator should unwind cleanly so shutdown isn't blocked.
   */
  stream?(ctx: StreamContext): AsyncIterable<RawSourceItem>;

  /**
   * Optional webhook handler(s). When declared, the server's webhook
   * receiver mounts the handler's path and routes verified requests
   * through it. Adapters can return a single handler or an array if a
   * single source has multiple webhook endpoints (e.g. "push" and
   * "pull_request" for GitHub at different paths).
   */
  webhook?(ctx: WebhookContext): WebhookHandler | WebhookHandler[];

  /**
   * Optional project discovery. Adapters that know about user-owned
   * "project-shaped" resources (Confluence spaces, Bitbucket repos,
   * Google calendars, Obsidian top-level folders, etc.) implement this
   * so the `cortex add projects` wizard can offer auto-discovered
   * candidates rather than making the user hand-type slugs.
   *
   * Called by the wizard layer, not the scheduler. Safe to hit external
   * APIs here — the wizard is interactive and the user initiated it.
   * Implementations should cap results to something reasonable (50-ish)
   * and surface only resources the authenticated user can actually read.
   */
  discoverProjects?(): Promise<ProjectCandidate[]>;
}

/**
 * One candidate project surfaced by an adapter's `discoverProjects`.
 * The wizard shows these as a multi-select checklist and writes the
 * chosen entries into `config/projects.yaml`.
 */
export interface ProjectCandidate {
  /** Suggested kebab-case slug. Wizard may prompt to edit before save. */
  slug: string;
  /** Human-readable name. Typically the source resource's display name. */
  name: string;
  /** One-sentence hint shown under the name in the picker. */
  description?: string;
  /**
   * Source identifier the wizard writes into `projects.yaml.sources`,
   * e.g. `{ confluence_space: "ALPHA" }` or `{ bitbucket_repos:
   * ["alpha-api", "alpha-web"] }`. Keys match the schema in
   * `@onenomad/przm-cortex-core/src/project.ts`.
   */
  sourceHints?: Record<string, unknown>;
  /**
   * Adapter id (e.g. "confluence", "bitbucket"). Populated by the wizard
   * layer from the adapter, not the adapter itself — saves every
   * implementation from duplicating `sourceAdapter: "confluence"`.
   */
  sourceAdapter?: string;
}

/**
 * Adapter packages export a factory rather than an instance so the registry
 * can instantiate lazily after config validation.
 */
export type AdapterFactory = () => SourceAdapter;
