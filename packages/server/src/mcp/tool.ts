import type { z } from "zod";
import type { LoadedTaxonomy } from "../taxonomy.js";
import type { Logger, MemoryTypeRegistry } from "@onenomad/przm-cortex-core";
import type { LLMRouter } from "@onenomad/przm-cortex-llm-core";
import type { EngramClient } from "../clients/engram.js";
import type { EnrichmentQueue } from "../enrichment.js";
import type { ExtractorsConfig } from "../config.js";

/**
 * Execution context handed to every MCP tool. Thin by design — tools that
 * need more should take it at tool-construction time, not via this bag.
 *
 * Cortex 0.3+ is standalone: no subprocess MCP servers. The Engram /
 * Persona companions are not spawned. `engram` here is the in-process
 * pgvector-backed memory client (kept under that name to avoid a churn
 * rename across the tool surface).
 */
export interface ToolContext {
  taxonomy: LoadedTaxonomy;
  /** Live memory-type registry. Tools that ingest go through
   *  `memoryTypes.register()` instead of an ad-hoc enum check so the
   *  customer-extensible taxonomy is honored everywhere. */
  memoryTypes: MemoryTypeRegistry;
  logger: Logger;
  engram: EngramClient;
  /** Optional — only present when an LLM is configured. Tools should
   *  handle its absence gracefully (fall back to non-LLM output). */
  llmRouter?: LLMRouter;
  /**
   * Optional — present when Cortex is running in queue-based
   * enrichment mode (no local LLM, expects an MCP client to act as
   * enrichment provider via the protocol tools in
   * `mcp/tools/pending-enrichment-requests.ts` and
   * `submit-enrichment-result.ts`).
   */
  enrichmentQueue?: EnrichmentQueue;
  /**
   * Per-call correlation id, generated at the MCP tool-call boundary.
   * Tools that persist memories should stamp it on metadata so audit
   * trails can follow a user action through ingestion.
   */
  traceId?: string;
  /**
   * Workspace slug this tool call is scoped to, or null when the
   * session is in no-workspace mode. Resolved from the MCP session
   * binding (`set_session_workspace`) with a fallback to the legacy
   * state.json active pointer for unbound sessions. Retrieval tools
   * filter engram searches on this; workspace-scoped write tools
   * use `requireSessionWorkspace()` directly to throw cleanly when
   * there's nothing bound.
   */
  sessionWorkspace?: string | null;
  /**
   * Drop cached taxonomy for a workspace so the next tool call re-
   * reads people.yaml + projects.yaml from disk. Mutation tools
   * (add_person, add_project, update_user_identity) call this after
   * a successful write. Optional so tests + the stdio fallback path
   * can omit it.
   */
  invalidateTaxonomy?: (workspaceSlug: string) => void;
  /**
   * Ingest-time extractor config (ADR-020). Controls which LLM-backed
   * metadata extractors run at ingest. Optional — absent means all
   * extractors are disabled (default behavior).
   */
  extractorsConfig?: ExtractorsConfig;
}

/**
 * Common shape for every Cortex MCP tool. One tool per file in mcp/tools/;
 * register them all through mcp/tools/index.ts.
 *
 * The schema is typed as `ZodTypeAny`, not `ZodType<TInput>`, because
 * `.default()` produces a schema whose input and output differ. Handlers
 * receive the post-parse (output) type via `z.output<TSchema>`.
 */
export interface McpTool<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  handler(input: z.output<TSchema>, ctx: ToolContext): Promise<TOutput>;
}

/** Erased variant for registries that hold a heterogeneous list of tools. */
export type AnyMcpTool = McpTool<z.ZodTypeAny, unknown>;
