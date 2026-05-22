/**
 * `/api/dashboard/stats` — knowledge-base size + freshness for the
 * Dashboard Stats page. Wraps the same engram `healthCheck()` the
 * MCP `kb_stats` tool reads, then layers per-source counts and recent
 * activity by querying engram directly.
 *
 * Response shape:
 *   {
 *     kb:    { healthy, totalChunks, ...details }          // raw engram stats
 *     sources: [{ source, count, lastIngestAt }]           // per-source breakdown
 *     recentActivity: { last24h, last7d }                  // simple counters
 *     workspace
 *   }
 *
 * Auth: scoped to `read`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import type { EngramMemory } from "../../clients/engram.js";

const KNOWN_SOURCES = [
  "manual",
  "loom",
  "google_meet",
  "confluence",
  "notion",
  "google_drive",
  "jira",
  "linear",
  "bitbucket",
  "github",
  "calendar",
  "slack",
  "teams",
  "email",
  "obsidian",
] as const;

interface SourceStat {
  source: string;
  count: number;
  lastIngestAt: string | null;
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (ctx.pathname !== "/api/dashboard/stats") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const gate = requireDashboardAuth(["read"]);
  const session = await gate(req, res);
  if (!session) return true;
  const workspace = session.session.workspace ?? "";

  // 1. Engram-side stats: total chunks, freshness, backend health.
  let kbHealthy = false;
  let kbDetails: Record<string, unknown> = {};
  let kbMessage = "";
  let kbLastSuccessAt: string | null = null;
  try {
    const health = await ctx.opts.engram.healthCheck();
    kbHealthy = health.healthy === true;
    kbDetails = (health as { details?: Record<string, unknown> }).details ?? {};
    const last = (health as { lastSuccessAt?: number }).lastSuccessAt;
    kbLastSuccessAt = typeof last === "number" ? new Date(last).toISOString() : null;
    kbMessage = health.message ?? "";
  } catch (err) {
    kbMessage = err instanceof Error ? err.message : String(err);
  }

  // 2. Per-source counts. Engram's search isn't a SQL surface, so each
  //    source is a separate broad query with a tag filter. Limit is
  //    high enough to count without burning the box; values >500
  //    surface as ">=500" rather than a real count (the Dashboard
  //    indicates this with a "+" suffix).
  const sources: SourceStat[] = [];
  for (const src of KNOWN_SOURCES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const rows = await ctx.opts.engram.search({
        query: "*",
        limit: 500,
        source: src,
        ...(workspace ? { workspace } : {}),
      });
      if (rows.length === 0) continue;
      sources.push({
        source: src,
        count: rows.length,
        lastIngestAt: latestIngestAt(rows),
      });
    } catch {
      // Per-source failure is non-fatal — surface what we have.
    }
  }

  // 3. Recent activity counters. Two windows; same broad search +
  //    client-side date filtering. Cheap because engram caps the row
  //    count regardless.
  let last24h = 0;
  let last7d = 0;
  try {
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await ctx.opts.engram.search({
      query: "*",
      limit: 500,
      sinceIso: since7,
      ...(workspace ? { workspace } : {}),
    });
    last7d = rows.length;
    last24h = rows.filter((r) => {
      const when = r.createdAt ?? extractDate(r);
      return typeof when === "string" && when >= since24;
    }).length;
  } catch {
    // Non-fatal — counters fall through as zero.
  }

  sendJson(res, 200, {
    kb: {
      healthy: kbHealthy,
      message: kbMessage,
      lastSuccessAt: kbLastSuccessAt,
      ...kbDetails,
    },
    sources,
    recentActivity: { last24h, last7d },
    workspace,
  });
  return true;
}

function latestIngestAt(rows: EngramMemory[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const when = r.createdAt ?? extractDate(r);
    if (typeof when !== "string") continue;
    if (best === null || when > best) best = when;
  }
  return best;
}

function extractDate(row: EngramMemory): string | undefined {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const d = meta.date;
  return typeof d === "string" ? d : undefined;
}
