import type { Logger } from "@onenomad/cortex-core";
import type { LLMRouter } from "@onenomad/cortex-llm-core";
import type { EngramClient } from "../clients/engram.js";
import type { LoadedTaxonomy } from "../taxonomy.js";

/**
 * Context passed to every widget handler. Mirrors `ToolContext` (the MCP
 * tool context) deliberately — widgets are HTTP-shaped projections of the
 * same underlying data plane, so sharing the shape means a widget and a
 * tool can be cross-implemented without plumbing changes.
 */
export interface WidgetContext {
  logger: Logger;
  engram: EngramClient;
  llmRouter: LLMRouter;
  taxonomy: LoadedTaxonomy;
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
