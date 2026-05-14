/**
 * MCP console endpoints — the dashboard's /mcp page lists every
 * registered tool and lets the operator invoke one with JSON args. Runs
 * in-process against the same ToolContext the MCP server uses, so
 * behavior matches a call from Claude Code 1:1.
 *
 * - GET  /api/mcp/tools                — catalog: name, description, inputSchema
 * - POST /api/mcp/tools/:name/invoke   — execute with JSON args; returns result + elapsed ms + traceId
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { RouteContext } from "../route-context.js";
import { readJsonBody, sendJson } from "../http.js";
import { ALL_TOOLS } from "../../mcp/tools/index.js";
import type { AnyMcpTool, ToolContext } from "../../mcp/tool.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;
  if (pathname !== "/api/mcp/tools" && !pathname.startsWith("/api/mcp/tools/")) {
    return false;
  }

  try {
    if (req.method === "GET" && pathname === "/api/mcp/tools") {
      const tools = ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }),
      }));
      sendJson(res, 200, { tools });
      return true;
    }

    const invokeMatch = pathname.match(/^\/api\/mcp\/tools\/([^/]+)\/invoke$/);
    if (req.method === "POST" && invokeMatch) {
      const name = decodeURIComponent(invokeMatch[1]!);
      const tool = ALL_TOOLS.find((t) => t.name === name) as
        | AnyMcpTool
        | undefined;
      if (!tool) {
        sendJson(res, 404, { error: `tool '${name}' not registered` });
        return true;
      }
      const body = (await readJsonBody(req)) as { input?: unknown } | null;
      const rawInput = body?.input ?? {};

      let parsed: unknown;
      try {
        parsed = tool.inputSchema.parse(rawInput);
      } catch (err) {
        sendJson(res, 400, {
          error: `input validation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return true;
      }

      // Resolve the currently active workspace's taxonomy, not the one
      // cortex booted against. Without this the console keeps showing
      // boot-time projects after the user switches workspaces via the
      // dashboard's switcher.
      const activeWs = await getActiveWorkspace().catch(() => undefined);
      const liveTaxonomy =
        activeWs && ctx.opts.taxonomyCache
          ? await ctx.opts.taxonomyCache.forWorkspace(activeWs.slug)
          : ctx.opts.taxonomy;
      const toolCtx: ToolContext = {
        taxonomy: liveTaxonomy,
        memoryTypes: ctx.opts.memoryTypes,
        logger: ctx.logger.child({
          component: "mcp-console",
          tool: name,
          ...(activeWs ? { workspace: activeWs.slug } : {}),
        }),
        engram: ctx.opts.engram,
        ...(ctx.opts.llmRouter ? { llmRouter: ctx.opts.llmRouter } : {}),
        traceId: randomUUID(),
        sessionWorkspace: activeWs?.slug ?? null,
        ...(ctx.opts.taxonomyCache
          ? {
              invalidateTaxonomy: (slug: string) =>
                ctx.opts.taxonomyCache!.invalidate(slug),
            }
          : {}),
      };
      const startedAt = Date.now();
      try {
        const result = await tool.handler(parsed, toolCtx);
        sendJson(res, 200, {
          result,
          elapsedMs: Date.now() - startedAt,
          traceId: toolCtx.traceId,
        });
      } catch (err) {
        ctx.logger.warn("api.mcp.tool_failed", {
          tool: name,
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - startedAt,
          traceId: toolCtx.traceId,
        });
      }
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.mcp.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
