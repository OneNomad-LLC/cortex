/**
 * Cortex Enrichment Protocol v1.
 *
 * Cortex Core is a data plane: it stores raw content and exposes
 * retrieval. Enrichment (categorization, action extraction,
 * summarization, entity tagging) is a compute-plane concern. When a
 * local LLM is configured Cortex performs enrichment in-process.
 * Otherwise it queues an enrichment request and lets a connected MCP
 * client (Pyre, Claude Desktop, any MCP-aware agent) consume the
 * queue and post results back.
 *
 * See `docs/enrichment-protocol.md` for the wire-format spec.
 */

export type EnrichmentType =
  | "categorize"
  | "extract_actions"
  | "summarize"
  | "tag_entities";

export interface EnrichmentRequest<T extends EnrichmentType = EnrichmentType> {
  /** What kind of enrichment is being asked for. */
  type: T;
  /**
   * Free-form input. Stable per-type shape:
   *  - categorize: `{ content: string }`
   *  - extract_actions: `{ content: string, source: string }`
   *  - summarize: `{ content: string, hint?: string }`
   *  - tag_entities: `{ content: string }`
   */
  payload: Record<string, unknown>;
  /**
   * Optional caller context (project, source, traceId). Passed
   * through verbatim so the enrichment provider can route or score
   * differently per source.
   */
  context?: Record<string, unknown>;
}

/** Result shape for `categorize`. */
export interface CategorizeResult {
  category: string;
  confidence: number;
  tags: string[];
}

/** Result shape for `extract_actions`. */
export interface ExtractActionsResult {
  actions: Array<{
    description: string;
    assignee?: string;
    due?: string;
    source: string;
  }>;
}

/** Result shape for `summarize`. */
export interface SummarizeResult {
  summary: string;
  key_points: string[];
}

/** Result shape for `tag_entities`. */
export interface TagEntitiesResult {
  entities: Array<{
    name: string;
    type: "person" | "project" | "company" | "product";
    confidence: number;
  }>;
}

export type EnrichmentResultByType = {
  categorize: CategorizeResult;
  extract_actions: ExtractActionsResult;
  summarize: SummarizeResult;
  tag_entities: TagEntitiesResult;
};

export type EnrichmentResult<T extends EnrichmentType = EnrichmentType> =
  EnrichmentResultByType[T];

export interface EnrichmentError {
  error: {
    /** Stable error code; clients pattern-match. */
    code:
      | "no_provider"
      | "timeout"
      | "invalid_payload"
      | "provider_error"
      | "unsupported_type";
    message: string;
  };
}

export type EnrichmentResponse<T extends EnrichmentType = EnrichmentType> =
  | EnrichmentResult<T>
  | EnrichmentError;

/**
 * Pluggable enrichment provider. The pipeline never sees the
 * implementation — just calls `enrich(request)` and falls back to
 * raw storage if the response is null or an error.
 *
 * Three concrete implementations live in the server package:
 *   - `LlmEnrichmentClient` — backed by the in-process LLM router.
 *   - `QueueEnrichmentClient` — queues requests for an MCP client
 *     (Pyre) to consume via the enrichment-protocol tools.
 *   - `NoopEnrichmentClient` — stores raw, no enrichment.
 */
export interface EnrichmentClient {
  enrich<T extends EnrichmentType>(
    request: EnrichmentRequest<T>,
  ): Promise<EnrichmentResult<T> | null>;
}

/** Helper: discriminator for EnrichmentResponse. */
export function isEnrichmentError(
  res: EnrichmentResponse,
): res is EnrichmentError {
  return (
    typeof res === "object" &&
    res !== null &&
    "error" in res &&
    typeof (res as EnrichmentError).error?.code === "string"
  );
}
