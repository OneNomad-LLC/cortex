import { upcomingBriefs } from "../../mcp/tools/upcoming-briefs.js";
import type { ToolContext } from "../../mcp/tool.js";
import type { Widget, WidgetContext } from "../types.js";

/**
 * The dashboard version of the `upcoming_briefs` MCP tool. We deliberately
 * reuse the tool's handler (rather than reimplementing the context-gather
 * logic) so the two surfaces never drift.
 *
 * Differences vs. the MCP tool:
 *   - `generateBrief` defaults to `false`. The widget is glanceable — full
 *     LLM synthesis is a click away in Claude. Operators who want briefs
 *     rendered on the dashboard can set `props.generateBrief: true` in
 *     dashboard.yaml, at the cost of an Ollama call per event per render.
 *   - Query params are parsed with lenient defaults so a no-config preset
 *     entry (`{ name: "upcoming-briefs" }`) still works.
 */
export const upcomingBriefsWidget: Widget = {
  name: "upcoming-briefs",
  description:
    "Upcoming meetings with a context payload (attendees, decisions, open action items). Optional LLM-generated brief per event.",

  async handler(query, ctx) {
    const hoursAhead = clampInt(query.get("hoursAhead"), 1, 168, 24);
    const minutesThreshold = clampInt(
      query.get("minutesThreshold"),
      0,
      1440,
      0,
    );
    const limit = clampInt(query.get("limit"), 1, 20, 5);
    const project = (query.get("project") ?? "").trim();
    const generateBrief =
      (query.get("generateBrief") ?? "").toLowerCase() === "true";

    return upcomingBriefs.handler(
      {
        hoursAhead,
        minutesThreshold,
        limit,
        generateBrief,
        project,
      },
      toToolContext(ctx),
    );
  },
};

function clampInt(
  raw: string | null,
  lo: number,
  hi: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Build a minimal ToolContext from a WidgetContext. The widget shares the
 * engram/llmRouter/taxonomy/logger bag with MCP tools, but doesn't have
 * persona (tools that need persona can't be widget-wrapped without
 * extending WidgetContext). upcoming_briefs doesn't use persona today.
 */
function toToolContext(ctx: WidgetContext): ToolContext {
  return {
    taxonomy: ctx.taxonomy,
    logger: ctx.logger,
    engram: ctx.engram,
    persona: undefined as never,
    ...(ctx.llmRouter ? { llmRouter: ctx.llmRouter } : {}),
  };
}
