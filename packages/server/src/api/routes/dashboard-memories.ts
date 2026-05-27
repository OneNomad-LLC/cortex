/**
 * `/api/dashboard/memories[...]` — paginated memory browser for the
 * Dashboard SPA. Sits on top of the same engram.search surface the
 * MCP `kb_search` + `kb_recent` tools use, but exposes the filter
 * shape the Memories page needs (multi-type, since-date, page/perPage)
 * in one round-trip.
 *
 * Surface:
 *   GET /api/dashboard/memories?type=brief&type=doc&source=github
 *                              &project=alpha&since=ISO&page=N&perPage=M
 *                              &query=free-text
 *   GET /api/dashboard/memories/:id            — full content + tags + metadata
 *
 * Auth: scoped to `admin`. Memory contents can include credentials in
 * notes, decision logs, etc. — keep the surface admin-only.
 *
 * Note on multi-type filtering: engram.search only accepts a single
 * type. Multi-select on the UI fires N parallel searches and merges
 * client-side here. For a small N (<= 13 — the full Cortex type
 * enum) the fan-out is cheap, and engram's per-call limits keep the
 * worst case bounded.
 *
 * Note on the dossier badge: a memory carries the "dossier" tag plus
 * `type=brief` when emitted by `pipeline-code-dossier` (Slice A). The
 * shape we surface here passes through the raw tag list so the SPA
 * can detect the badge without a server-side conditional.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { getActiveWorkspace } from "../../cli/workspace/manager.js";
import type { EngramMemory } from "../../clients/engram.js";

/**
 * Same enum as `kb_search`'s `type` field. Whitelisting keeps a hostile
 * caller from filtering by a synthetic tag string that bypasses the
 * intended set of types. Anything else surfaces as 400.
 */
const VALID_TYPES = new Set<string>([
  "meeting",
  "decision",
  "action_item",
  "doc",
  "code",
  "note",
  "brief",
  "digest",
  "conversation",
  "commit",
  "event",
  "reference",
  "session_handoff",
]);

const VALID_SOURCES = new Set<string>([
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
  "manual",
]);

const MAX_PER_PAGE = 200;
const DEFAULT_PER_PAGE = 50;
/**
 * Hard cap per-type fetch from engram. Each fan-out hits this ceiling
 * before page slicing; with N types selected the worst-case API budget
 * is N × FETCH_CAP. Picked at 500 to match dashboard-stats.ts.
 */
const FETCH_CAP = 500;

interface MemoryRow {
  id: string;
  title: string | null;
  type: string | null;
  source: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  project: string | null;
  date: string | null;
  createdAt: string | null;
  /** Truncated for the list view. The detail endpoint returns the full body. */
  snippet: string;
  tags: string[];
  /** True iff `type === 'brief'` AND tags include `dossier`. */
  isDossier: boolean;
}

interface MemoryDetail extends MemoryRow {
  content: string;
  metadata: Record<string, unknown>;
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/dashboard/memories")) return false;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const gate = requireDashboardAuth(["admin"]);
  const session = await gate(req, res);
  if (!session) return true;
  // Hybrid fallback: when the dashboard session hasn't explicitly bound a
  // workspace, scope to the last-active workspace (state.json) instead of
  // leaking every workspace's memories into the browser. engram.search
  // scopes by the resolved slug; only a session that is both unbound AND
  // has no active pointer sees the unscoped set.
  let workspace = session.session.workspace ?? "";
  if (!workspace) {
    const active = await getActiveWorkspace();
    workspace = active?.slug ?? "";
  }

  // Detail route: /api/dashboard/memories/:id
  // Memory ids in engram are opaque slugs; allow anything except a slash.
  const detailMatch = ctx.pathname.match(/^\/api\/dashboard\/memories\/([^/]+)$/);
  if (detailMatch) {
    return await handleDetail(
      res,
      ctx,
      decodeURIComponent(detailMatch[1]!),
      workspace,
    );
  }

  if (ctx.pathname !== "/api/dashboard/memories") {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  return await handleList(res, ctx, workspace);
}

async function handleList(
  res: ServerResponse,
  ctx: RouteContext,
  workspace: string,
): Promise<boolean> {
  const url = ctx.url;
  const query = (url.searchParams.get("query") ?? "").trim();
  // Multi-select: ?type=X&type=Y. Drop unknowns rather than 400 — the
  // SPA's enum may drift slightly ahead of the server during a deploy.
  const rawTypes = url.searchParams.getAll("type");
  const types = rawTypes.filter((t) => VALID_TYPES.has(t));
  const sourceParam = url.searchParams.get("source");
  const source = sourceParam && VALID_SOURCES.has(sourceParam) ? sourceParam : null;
  const project = (url.searchParams.get("project") ?? "").trim() || null;
  const sinceRaw = url.searchParams.get("since");
  // since may be either a plain date (YYYY-MM-DD) or full ISO. Coerce
  // to ISO 8601 (start of day, UTC) when only a date is given.
  let sinceIso: string | null = null;
  if (sinceRaw) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)) {
      sinceIso = `${sinceRaw}T00:00:00.000Z`;
    } else {
      const parsed = Date.parse(sinceRaw);
      if (Number.isFinite(parsed)) sinceIso = new Date(parsed).toISOString();
    }
  }

  const page = clampInt(url.searchParams.get("page"), 1, 1000, 1);
  const perPage = clampInt(
    url.searchParams.get("perPage"),
    1,
    MAX_PER_PAGE,
    DEFAULT_PER_PAGE,
  );

  // Engram's search needs a non-empty query — use a single space when
  // no free-text term is provided, matching kb_recent's "any" sentinel.
  const effectiveQuery = query.length > 0 ? query : " ";

  // Fan out across the type filter. No types = single query with no
  // type filter (returns all types).
  const typeQueries = types.length > 0 ? types : [null];
  const fanout = await Promise.all(
    typeQueries.map((t) =>
      ctx.opts.engram
        .search({
          query: effectiveQuery,
          limit: FETCH_CAP,
          domain: "work",
          ...(t ? { type: t } : {}),
          ...(source ? { source } : {}),
          ...(project ? { project } : {}),
          ...(sinceIso ? { sinceIso } : {}),
          ...(workspace ? { workspace } : {}),
        })
        .catch(() => [] as EngramMemory[]),
    ),
  );

  // De-dup by id (a row could match multiple types only if it carried
  // multiple cortex_type tags, but be defensive).
  const seen = new Set<string>();
  const aggregated: EngramMemory[] = [];
  for (const batch of fanout) {
    for (const row of batch) {
      if (!row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      aggregated.push(row);
    }
  }

  // Newest-first ordering. Engram orders by relevance score, not date,
  // so we re-sort here to match the Memories-page intent (browse by
  // recency unless the user provides a query).
  aggregated.sort((a, b) => extractDate(b).localeCompare(extractDate(a)));

  const total = aggregated.length;
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const slice = aggregated.slice(start, end);

  sendJson(res, 200, {
    memories: slice.map(toRow),
    total,
    page,
    perPage,
    hasMore: end < total,
    workspace,
  });
  return true;
}

async function handleDetail(
  res: ServerResponse,
  ctx: RouteContext,
  id: string,
  workspace: string,
): Promise<boolean> {
  // Engram doesn't expose a "fetch by id" API today — we search broadly
  // and filter for the requested id. This is wasteful for a single
  // record but matches the same pattern admin-memory.ts uses. Worst
  // case the row isn't in the first 500 results; we accept that as a
  // future optimization (add engram.getById when the underlying
  // adapter supports it).
  const rows = await ctx.opts.engram.search({
    query: " ",
    limit: FETCH_CAP,
    domain: "work",
    ...(workspace ? { workspace } : {}),
  });
  const hit = rows.find((r) => r.id === id);
  if (!hit) {
    sendJson(res, 404, { error: "not_found", id });
    return true;
  }
  const row = toRow(hit);
  const detail: MemoryDetail = {
    ...row,
    content: hit.content,
    metadata: hit.metadata ?? {},
  };
  sendJson(res, 200, { memory: detail });
  return true;
}

function toRow(row: EngramMemory): MemoryRow {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(row.tags)
    ? (row.tags as string[])
    : Array.isArray(meta.tags)
      ? ((meta.tags as unknown[]).filter(
          (t): t is string => typeof t === "string",
        ))
      : [];
  const tagSet = new Set(tags);
  const type =
    typeof meta.type === "string"
      ? (meta.type as string)
      : pickTaggedValue(tags, "cortex_type") ?? null;
  const source =
    typeof meta.source === "string"
      ? (meta.source as string)
      : pickTaggedValue(tags, "source") ?? null;
  const sourceId =
    typeof meta.source_id === "string"
      ? (meta.source_id as string)
      : typeof meta.sourceId === "string"
        ? (meta.sourceId as string)
        : pickTaggedValue(tags, "source_id") ?? null;
  const projectRaw = meta.project;
  const project =
    typeof projectRaw === "string"
      ? projectRaw
      : Array.isArray(projectRaw)
        ? ((projectRaw as unknown[]).find((p) => typeof p === "string") as
            | string
            | undefined) ?? null
        : pickTaggedValue(tags, "project") ?? null;
  const sourceUrl =
    typeof meta.source_url === "string"
      ? (meta.source_url as string)
      : typeof meta.sourceUrl === "string"
        ? (meta.sourceUrl as string)
        : null;
  const title = typeof meta.title === "string" ? (meta.title as string) : null;
  const date =
    typeof meta.date === "string"
      ? (meta.date as string)
      : pickTaggedValue(tags, "date") ?? null;
  const snippet =
    row.content.length > 280 ? `${row.content.slice(0, 280)}…` : row.content;
  const isDossier = type === "brief" && tagSet.has("dossier");
  return {
    id: row.id,
    title,
    type,
    source,
    sourceId,
    sourceUrl,
    project,
    date,
    createdAt: row.createdAt ?? null,
    snippet,
    tags,
    isDossier,
  };
}

function pickTaggedValue(tags: string[], key: string): string | null {
  const prefix = `${key}:`;
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      const value = tag.slice(prefix.length);
      if (value.length > 0) return value;
    }
  }
  return null;
}

function extractDate(row: EngramMemory): string {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.date === "string") return meta.date;
  if (typeof row.createdAt === "string") return row.createdAt;
  return "";
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
