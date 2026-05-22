/**
 * `/api/dashboard/ingest/*` — three flavors of write-API the Dashboard
 * Ingest page submits to. Each thin wrapper around the corresponding
 * MCP tool (`ingest_url`, `ingest_file`, `ingest_content`) so the
 * dashboard sees the same ingest pipeline an MCP client would.
 *
 * Routes:
 *   POST /api/dashboard/ingest/url      → { jobId, queued: true } (async)
 *   POST /api/dashboard/ingest/file     → { jobId } or sync result
 *   POST /api/dashboard/ingest/content  → sync ingest result
 *
 * Auth: every endpoint requires the `ingest` scope. `admin` satisfies
 * it via the gate's scope expansion.
 *
 * The MCP tools key off `ToolContext.sessionWorkspace`. Dashboard
 * sessions don't go through `set_session_workspace`, so the route
 * resolves the workspace from the gate (cookie / bearer scope) and
 * plumbs it through `ToolContext`. Re-using the tool keeps the
 * pipeline + auto-enrichment + taxonomy validation identical between
 * MCP and Dashboard origins.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import type { ToolContext } from "../../mcp/tool.js";
import { ingestUrl } from "../../mcp/tools/ingest-url.js";
import { ingestFile } from "../../mcp/tools/ingest-file.js";
import { ingestContent } from "../../mcp/tools/ingest-content.js";
import type { AnyMcpTool } from "../../mcp/tool.js";

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/dashboard/ingest/")) return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const gate = requireDashboardAuth(["ingest"]);
  const session = await gate(req, res);
  if (!session) return true;

  const workspace = session.session.workspace ?? "";
  let body: Record<string, unknown>;
  try {
    body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "invalid_body" });
    return true;
  }

  switch (ctx.pathname) {
    case "/api/dashboard/ingest/url":
      return invoke(req, res, ctx, ingestUrl as AnyMcpTool, normalizeUrlInput(body), workspace);
    case "/api/dashboard/ingest/file":
      return invoke(req, res, ctx, ingestFile as AnyMcpTool, normalizeFileInput(body), workspace);
    case "/api/dashboard/ingest/content":
      return invoke(req, res, ctx, ingestContent as AnyMcpTool, body, workspace);
    default:
      sendJson(res, 404, { error: "not_found" });
      return true;
  }
}

function normalizeUrlInput(body: Record<string, unknown>): Record<string, unknown> {
  // Default to async crawl — the URL ingest tool defaults to async
  // anyway, but pinning it here keeps the dashboard's response shape
  // predictable ("we always return a jobId for URL ingest").
  return { async: true, ...body };
}

function normalizeFileInput(body: Record<string, unknown>): Record<string, unknown> {
  // Dashboard form posts `path` keyed input directly today. Multipart
  // upload is a follow-up — gated behind the same /ingest/file URL so
  // the client only ever talks to one endpoint.
  return body;
}

async function invoke(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  tool: AnyMcpTool,
  rawInput: Record<string, unknown>,
  workspace: string,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = tool.inputSchema.parse(rawInput);
  } catch (err) {
    sendJson(res, 400, {
      error: "invalid_input",
      message: err instanceof Error ? err.message : String(err),
    });
    return true;
  }

  const traceId = randomUUID();
  const toolCtx: ToolContext = {
    taxonomy: ctx.opts.taxonomy,
    memoryTypes: ctx.opts.memoryTypes,
    logger: ctx.logger.child({
      component: "dashboard-ingest",
      tool: tool.name,
      ...(workspace ? { workspace } : {}),
      traceId,
    }),
    engram: ctx.opts.engram,
    ...(ctx.opts.llmRouter ? { llmRouter: ctx.opts.llmRouter } : {}),
    traceId,
    sessionWorkspace: workspace || null,
  };

  const startedAt = Date.now();
  try {
    const result = (await tool.handler(parsed, toolCtx)) as Record<string, unknown>;
    sendJson(res, 200, {
      ok: true,
      ...result,
      elapsedMs: Date.now() - startedAt,
      traceId,
    });
  } catch (err) {
    ctx.logger.warn("api.dashboard.ingest_failed", {
      tool: tool.name,
      error: err instanceof Error ? err.message : String(err),
      traceId,
    });
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startedAt,
      traceId,
    });
  }
  return true;
}
