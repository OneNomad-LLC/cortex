import type { Logger } from "@onenomad/cortex-core";
import type { LLMRouter } from "@onenomad/cortex-llm-core";
import type { EngramClient } from "../clients/engram.js";
import type { LoadedTaxonomy } from "../taxonomy.js";
import type { MemoryTypeRegistry } from "@onenomad/cortex-core";
import type { Workspace } from "../cli/workspace/manager.js";

/**
 * Context passed to every widget handler. Mirrors `ToolContext` (the MCP
 * tool context) deliberately — widgets are HTTP-shaped projections of the
 * same underlying data plane, so sharing the shape means a widget and a
 * tool can be cross-implemented without plumbing changes.
 *
 * `workspace` is the per-request workspace resolved from the dashboard's
 * `?workspace=<slug>` query param (Phase 1b — workspace bleed fix).
 * Falls back to `getActiveWorkspace()` when the query param is absent
 * (preserves behavior for clients that don't pass workspace).
 * Widget handlers filter results by `ctx.workspace?.slug` when set.
 */
export interface WidgetContext {
  logger: Logger;
  engram: EngramClient;
  /** Optional in Cortex 0.2 — undefined when no LLM provider is
   *  installed. Widgets that need it must check before calling. */
  llmRouter?: LLMRouter;
  taxonomy: LoadedTaxonomy;
  /** Customer-extensible memory-type registry. The /api/types endpoint
   *  reads from this; the MCP console's tool invoker threads it into
   *  the ToolContext so auto-add works from dashboard-driven ingests. */
  memoryTypes: MemoryTypeRegistry;
  workspace?: Workspace;
}

/**
 * Widget handler contract. Receives the parsed query string and returns
 * a JSON-serializable payload. Handlers should never throw for user-input
 * reasons — return an `error` field instead so the dashboard can render
 * something sensible.
 */
export interface Widget<TOutput = unknown> {
  /** URL segment: `/api/widgets/<name>`. Kebab-case. */
  name: string;
  /** One-line description for `/api/widgets` discovery. */
  description: string;
  handler(
    query: URLSearchParams,
    ctx: WidgetContext,
  ): Promise<TOutput>;
}
