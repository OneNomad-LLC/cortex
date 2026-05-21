/**
 * `/api/dashboard/jobs[...]` — listings + per-id detail for the Jobs
 * page. Reads from the persistent JobRegistry shadow (`cache_jobs`
 * table) so historical entries survive a process restart, with the
 * in-memory map serving as the hot-path cache for currently-running
 * jobs.
 *
 * Surface:
 *   GET /api/dashboard/jobs?status=in_progress|recent&limit=N
 *   GET /api/dashboard/jobs/:jobId
 *
 * `status=in_progress` returns queued + running (the two non-terminal
 * states). `status=recent` returns completed + failed within the last
 * 24h. Omit `status` to get everything (newest first).
 *
 * Auth: scoped to `read`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { jobs, type JobRecord } from "../../mcp/jobs.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface JobView {
  jobId: string;
  type: string;
  status: JobRecord["status"];
  workspace: string;
  progress: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toView(job: JobRecord): JobView {
  return {
    jobId: job.id,
    type: job.kind,
    status: job.status,
    workspace: job.workspace,
    progress: Object.keys(job.progress).length > 0 ? job.progress : null,
    error: job.error,
    createdAt: new Date(job.createdAtMs).toISOString(),
    startedAt: job.startedAtMs != null ? new Date(job.startedAtMs).toISOString() : null,
    finishedAt: job.finishedAtMs != null ? new Date(job.finishedAtMs).toISOString() : null,
  };
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/dashboard/jobs")) return false;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const gate = requireDashboardAuth(["read"]);
  const session = await gate(req, res);
  if (!session) return true;
  const workspace = session.session.workspace ?? "";

  // Detail route: /api/dashboard/jobs/:jobId
  const detailMatch = ctx.pathname.match(/^\/api\/dashboard\/jobs\/([^/]+)$/);
  if (detailMatch) {
    const jobId = decodeURIComponent(detailMatch[1]!);
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: "not_found", jobId });
      return true;
    }
    // Hide cross-workspace job detail. Bound sessions only see their
    // own slug + unbound (empty string) jobs. Without this, anyone
    // with `read` could enumerate another workspace's job ids.
    if (job.workspace && job.workspace !== workspace) {
      sendJson(res, 404, { error: "not_found", jobId });
      return true;
    }
    sendJson(res, 200, { job: toView(job) });
    return true;
  }

  if (ctx.pathname !== "/api/dashboard/jobs") {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  // List route.
  const status = ctx.url.searchParams.get("status");
  const limitRaw = ctx.url.searchParams.get("limit");
  const limit = limitRaw
    ? Math.max(1, Math.min(MAX_LIMIT, Number(limitRaw)))
    : DEFAULT_LIMIT;

  let records: JobRecord[];
  switch (status) {
    case "in_progress": {
      // queued + running — two listings union'd. Cheaper than fetching
      // every status and filtering client-side because the persistent
      // store indexes on (status, created_at DESC).
      const queued = jobs.list({ workspace, status: "queued", limit });
      const running = jobs.list({ workspace, status: "running", limit });
      records = [...running, ...queued]
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, limit);
      break;
    }
    case "recent": {
      const sinceMs = Date.now() - RECENT_WINDOW_MS;
      const completed = jobs.list({ workspace, status: "completed", sinceMs, limit });
      const failed = jobs.list({ workspace, status: "failed", sinceMs, limit });
      records = [...completed, ...failed]
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, limit);
      break;
    }
    default:
      records = jobs.list({ workspace, limit });
      break;
  }

  // Also include unbound-workspace jobs (no slug) — useful for
  // jobs created before the workspace was set, or unbound sessions.
  if (workspace !== "") {
    const unbound = jobs.list({ workspace: "", limit });
    const seen = new Set(records.map((r) => r.id));
    for (const job of unbound) {
      if (records.length >= limit) break;
      if (seen.has(job.id)) continue;
      if (status === "in_progress" && job.status !== "queued" && job.status !== "running") continue;
      if (status === "recent") {
        const sinceMs = Date.now() - RECENT_WINDOW_MS;
        if (job.status !== "completed" && job.status !== "failed") continue;
        if (job.createdAtMs < sinceMs) continue;
      }
      records.push(job);
    }
    records.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  const utilization = jobs.utilization();
  sendJson(res, 200, {
    jobs: records.slice(0, limit).map(toView),
    utilization,
    workspace,
  });
  return true;
}
