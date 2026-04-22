import type { z } from "zod";
import type { LoadedTaxonomy } from "../taxonomy.js";
import type { Logger } from "@cortex/core";

/**
 * Execution context handed to every MCP tool. Thin by design — tools that
 * need more should take it at tool-construction time, not via this bag.
 */
export interface ToolContext {
  taxonomy: LoadedTaxonomy;
  logger: Logger;
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
