/**
 * `/api/dashboard/github/repos[...]` — Dashboard surface for connecting
 * GitHub repos, syncing them, and removing them. Sits on top of the
 * existing `@onenomad/przm-cortex-adapter-github` (we add repos to its
 * config + enqueue sync jobs; we do NOT fork the adapter).
 *
 * Auth gate: every endpoint requires the `admin` scope. Slice A puts
 * the resolved OAuth access token onto SessionState as
 * `githubAccessToken`; we read it via a typed accessor that tolerates
 * the token being absent (returns 412 `github_not_connected` so the
 * SPA can prompt the user to reconnect).
 *
 * Routes:
 *   GET    /api/dashboard/github/repos?page=N&per_page=M&filter=…
 *   POST   /api/dashboard/github/repos/sync   body { repos: [...] }
 *   POST   /api/dashboard/github/repos/:owner/:name/sync
 *   DELETE /api/dashboard/github/repos/:owner/:name?purge=true|false
 *
 * Sync semantics: connecting a repo writes it into
 * `adapters.github.config.repos` (creates the adapter entry if it
 * doesn't exist yet) and enqueues a `github-sync:<owner>/<name>` job
 * via the global JobRegistry. The work the job runs is the existing
 * `ingest_repo` MCP tool with the `https://github.com/...` URL — that
 * path already handles shallow-clone + glob filtering + per-file
 * ingest + engram dedup, so we get full repo ingestion without
 * duplicating any of the adapter's walk logic.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readJsonBody, sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import {
  appendGithubRepo,
  isGithubRepoMode,
  parseRepoIdentifier,
  readGithubModeSnapshot,
  readGithubRepoList,
  removeGithubRepo,
  resolveGithubRepoMode,
  setGithubRepoMode,
  type GithubRepoMode,
} from "../github-repo-config.js";
import { resolveConfigPath } from "../../cli/config-path.js";
import { jobs } from "../../mcp/jobs.js";
import { tryReload } from "../reload.js";
import { ingestRepo } from "../../mcp/tools/ingest-repo.js";
import type { ToolContext } from "../../mcp/tool.js";
import type { SessionState } from "../../session-context.js";

const ROUTE_PREFIX = "/api/dashboard/github/repos";
/**
 * Hard cap on how many pages of `/user/repos` we pull from GitHub. At
 * per_page=100 this works out to 1000 repos — enough for the over-
 * whelming majority of accounts. Anything beyond surfaces as
 * `hasMore: true` so the UI can either keep paging server-side via
 * `?page=` or just communicate "showing the most recent 1000".
 */
const MAX_GITHUB_PAGES = 10;
const GITHUB_PER_PAGE = 100;

/**
 * SessionState carries the OAuth access token after Device Flow login
 * (Slice A → `setGitHubSession`). Returns undefined when the user is
 * signed in via token-paste only (no GitHub binding) so callers 412
 * cleanly with `github_not_connected`.
 */
function getSessionGithubAccessToken(session: SessionState): string | undefined {
  const token = session.githubAccessToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

interface GithubRepoSummary {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  html_url: string;
  default_branch: string;
  language: string | null;
  pushed_at: string | null;
  owner: { login: string };
}

interface ReposViewItem {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
  pushedAt: string | null;
  htmlUrl: string;
  archived: boolean;
  fork: boolean;
  /** True when present in adapters.github.config.repos (we will sync). */
  ingested: boolean;
  lastSyncedAt?: string | null;
  memoryCount?: number;
  lastSyncJobId?: string | null;
  /**
   * Resolved ingestion mode. Falls back through:
   *   per-repo override → adapter-level default → "dossier".
   */
  mode: GithubRepoMode;
  /** Adapter-level default (null when not yet configured). */
  adapterMode: GithubRepoMode | null;
  /** True only when there's a per-repo entry in `repoModes`. */
  modeOverride: boolean;
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith(ROUTE_PREFIX)) return false;

  const gate = requireDashboardAuth(["admin"]);
  const resolved = await gate(req, res);
  if (!resolved) return true;

  try {
    if (req.method === "GET" && ctx.pathname === ROUTE_PREFIX) {
      return await handleList(req, res, ctx, resolved.session);
    }
    if (req.method === "POST" && ctx.pathname === `${ROUTE_PREFIX}/sync`) {
      return await handleSyncBatch(req, res, ctx);
    }
    const singleMatch = ctx.pathname.match(
      /^\/api\/dashboard\/github\/repos\/([^/]+)\/([^/]+?)(?:\/(sync|mode))?$/,
    );
    if (singleMatch) {
      const owner = decodeURIComponent(singleMatch[1]!);
      const name = decodeURIComponent(singleMatch[2]!);
      const subAction = singleMatch[3];
      if (req.method === "POST" && subAction === "sync") {
        return await handleSyncSingle(req, res, ctx, owner, name);
      }
      if (req.method === "POST" && subAction === "mode") {
        return await handleSetMode(req, res, ctx, owner, name);
      }
      if (req.method === "DELETE" && !subAction) {
        return await handleDelete(req, res, ctx, owner, name);
      }
    }
    sendJson(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    ctx.logger.warn("api.dashboard_github_repos.failed", {
      method: req.method,
      path: ctx.pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

async function handleList(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  session: SessionState,
): Promise<boolean> {
  const token = getSessionGithubAccessToken(session);
  if (!token) {
    // 412 (precondition required) communicates "you need to connect
    // GitHub first" without confusing the SPA's general 401/403 paths.
    sendJson(res, 412, { error: "github_not_connected" });
    return true;
  }

  const url = ctx.url;
  const page = clampInt(url.searchParams.get("page"), 1, 1000, 1);
  const perPage = clampInt(url.searchParams.get("per_page"), 1, 100, 30);
  const filter = (url.searchParams.get("filter") ?? "").trim().toLowerCase();

  // Aggregate up to MAX_GITHUB_PAGES * GITHUB_PER_PAGE repos. We page
  // GitHub directly (it has its own pagination) and apply our own
  // page/per_page on top. `hasMore` signals when GitHub still has
  // more rows beyond the cap.
  const aggregated: GithubRepoSummary[] = [];
  let githubHasMore = false;
  for (let p = 1; p <= MAX_GITHUB_PAGES; p++) {
    const apiUrl = new URL("https://api.github.com/user/repos");
    apiUrl.searchParams.set("sort", "updated");
    apiUrl.searchParams.set("per_page", String(GITHUB_PER_PAGE));
    apiUrl.searchParams.set("visibility", "all");
    apiUrl.searchParams.set("page", String(p));
    // eslint-disable-next-line no-await-in-loop
    const resp = await fetch(apiUrl.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "cortex-dashboard",
      },
    });
    if (resp.status === 401) {
      sendJson(res, 401, { error: "github_auth_expired" });
      return true;
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      sendJson(res, 502, {
        error: "github_proxy_failed",
        status: resp.status,
        detail: detail.slice(0, 300),
      });
      return true;
    }
    const batch = (await resp.json()) as GithubRepoSummary[];
    if (!Array.isArray(batch)) {
      sendJson(res, 502, { error: "github_unexpected_payload" });
      return true;
    }
    aggregated.push(...batch);
    if (batch.length < GITHUB_PER_PAGE) break;
    // Next iteration will fetch — and if we'd hit the cap, surface hasMore.
    if (p === MAX_GITHUB_PAGES) {
      githubHasMore = true;
      break;
    }
  }

  // Filter on the server so paging respects the post-filter total.
  // Match against the slug ("owner/name") and the description so a
  // user can search by either.
  const filtered = filter.length > 0
    ? aggregated.filter((r) =>
        r.full_name.toLowerCase().includes(filter) ||
        (r.description ?? "").toLowerCase().includes(filter),
      )
    : aggregated;

  // Merge ingested-state from cortex.yaml + latest sync job state from
  // JobRegistry. We don't surface memoryCount / lastSyncedAt here yet
  // — those need engram round-trips (per-source_id prefix scan +
  // max(createdAt)) that a future slice can light up. lastSyncJobId
  // drives the UI's "Syncing…" / "Failed" badges; we surface the most
  // recent job per repo.
  const configPath = resolveConfigPath();
  const [ingestedList, modeSnapshot] = await Promise.all([
    readGithubRepoList(configPath),
    readGithubModeSnapshot(configPath),
  ]);
  const ingestedSet = new Set(ingestedList);

  // Apply client paging.
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const slice = filtered.slice(start, end);

  // Scan recent github-sync jobs once and build a per-repo latest-job
  // index so the map below is O(1) per row. enqueueGithubSyncJob() sets
  // progress.repo on creation so we can tell which job belongs to which
  // repo. jobs.list() returns newest-first.
  const recentJobs = jobs.list({ limit: 500 });
  const latestJobByRepo = new Map<string, { id: string; status: string }>();
  for (const job of recentJobs) {
    if (job.kind !== "github-sync") continue;
    const repo = typeof job.progress.repo === "string" ? job.progress.repo : undefined;
    if (!repo) continue;
    if (!latestJobByRepo.has(repo)) {
      latestJobByRepo.set(repo, { id: job.id, status: job.status });
    }
  }

  const repos: ReposViewItem[] = slice.map((r) => {
    const latest = latestJobByRepo.get(r.full_name);
    const override = modeSnapshot.repoModes[r.full_name];
    return {
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      private: Boolean(r.private),
      defaultBranch: r.default_branch ?? "main",
      language: r.language ?? null,
      description: r.description ?? null,
      pushedAt: r.pushed_at ?? null,
      htmlUrl: r.html_url,
      archived: Boolean(r.archived),
      fork: Boolean(r.fork),
      ingested: ingestedSet.has(r.full_name),
      lastSyncJobId: latest?.id ?? null,
      mode: resolveGithubRepoMode(modeSnapshot, r.full_name),
      adapterMode: modeSnapshot.adapterMode,
      modeOverride: override !== undefined,
    };
  });

  sendJson(res, 200, {
    repos,
    total: filtered.length,
    hasMore: githubHasMore || end < filtered.length,
    page,
    perPage,
    /**
     * Adapter-level snapshot — the Connectors page reads this to
     * surface the "Dossier mode" subtitle on the GitHub card without
     * a separate round-trip.
     */
    adapterMode: modeSnapshot.adapterMode,
  });
  return true;
}

interface SyncBatchBody {
  repos?: unknown;
  /**
   * Optional per-repo mode overrides keyed by `owner/name`. Each value
   * must be one of the GithubRepoMode strings (or `null` to clear).
   * Unknown keys / invalid values are ignored — a malformed entry
   * doesn't block the sync.
   */
  modes?: unknown;
}

interface BatchResult {
  repo: string;
  jobId: string | null;
  status: "queued" | "already_connected" | "unauthorized";
}

async function handleSyncBatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const body = (await readJsonBody(req).catch(() => ({}))) as SyncBatchBody;
  const list = Array.isArray(body.repos) ? body.repos : [];
  if (list.length === 0) {
    sendJson(res, 400, { error: "repos array required" });
    return true;
  }

  const slugRe = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
  const configPath = resolveConfigPath();
  const results: BatchResult[] = [];
  let anyAdded = false;
  let anyModeChanged = false;

  // Normalize the optional `modes` map. Tolerant of shape — anything
  // non-string keys / non-enum values is silently dropped rather than
  // bouncing the whole batch.
  const modes: Record<string, GithubRepoMode | null> = {};
  if (body.modes && typeof body.modes === "object" && !Array.isArray(body.modes)) {
    for (const [slug, value] of Object.entries(
      body.modes as Record<string, unknown>,
    )) {
      if (!slugRe.test(slug)) continue;
      if (value === null) modes[slug] = null;
      else if (isGithubRepoMode(value)) modes[slug] = value as GithubRepoMode;
    }
  }

  for (const candidate of list) {
    if (typeof candidate !== "string" || !slugRe.test(candidate)) {
      results.push({
        repo: typeof candidate === "string" ? candidate : "(invalid)",
        jobId: null,
        status: "unauthorized",
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const { added } = await appendGithubRepo(configPath, candidate);
    if (added) anyAdded = true;
    // Apply optional mode override before enqueueing so the job picks
    // it up. Modes specified in the batch take precedence over any
    // existing per-repo entry.
    if (candidate in modes) {
      // eslint-disable-next-line no-await-in-loop
      const { changed } = await setGithubRepoMode(
        configPath,
        candidate,
        modes[candidate]!,
      );
      if (changed) anyModeChanged = true;
    }
    // Even when the repo was already connected we still enqueue a
    // sync job — the user explicitly asked to refresh. The
    // already-connected status differentiates "we added a new entry"
    // from "the entry was already there". This matches what `cortex
    // sync github` does today.
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await readGithubModeSnapshot(configPath);
    const resolvedMode = resolveGithubRepoMode(snapshot, candidate);
    const job = enqueueGithubSyncJob(ctx, candidate, { mode: resolvedMode });
    results.push({
      repo: candidate,
      jobId: job.id,
      status: added ? "queued" : "already_connected",
    });
  }
  if (anyAdded || anyModeChanged) {
    // Reload only when we wrote new repos — toggling does enough
    // bookkeeping to skip an unnecessary scheduler bounce when no
    // adapter config actually changed.
    await tryReload(ctx.opts, ctx.logger);
  }
  sendJson(res, 200, { jobs: results });
  return true;
}

async function handleSyncSingle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  owner: string,
  name: string,
): Promise<boolean> {
  const fullName = `${owner}/${name}`;
  const configPath = resolveConfigPath();
  const { added } = await appendGithubRepo(configPath, fullName);

  // Optional `{mode}` in the body lets the dashboard send the row's
  // override along with the sync click in one shot. Skipping/omitting
  // leaves whatever's already configured untouched. `null` clears.
  let modeChanged = false;
  try {
    const body = (await readJsonBody(req).catch(() => null)) as
      | { mode?: unknown }
      | null;
    if (body && body.mode !== undefined) {
      const next = body.mode === null ? null : body.mode;
      if (next === null || isGithubRepoMode(next)) {
        const { changed } = await setGithubRepoMode(
          configPath,
          fullName,
          next as GithubRepoMode | null,
        );
        modeChanged = changed;
      }
    }
  } catch {
    /* malformed bodies fall through — sync still runs */
  }

  if (added || modeChanged) await tryReload(ctx.opts, ctx.logger);
  const snapshot = await readGithubModeSnapshot(configPath);
  const job = enqueueGithubSyncJob(ctx, fullName, {
    mode: resolveGithubRepoMode(snapshot, fullName),
  });
  sendJson(res, 200, {
    repo: fullName,
    jobId: job.id,
    status: added ? "queued" : "already_connected",
    mode: resolveGithubRepoMode(snapshot, fullName),
  });
  return true;
}

interface SetModeBody {
  /** `null` = drop the per-repo override (fall back to adapter default). */
  mode?: unknown;
}

/**
 * `POST /api/dashboard/github/repos/:owner/:name/mode`
 *
 * Body: `{ mode: "dossier" | "full" | "both" | null }`
 *
 * Persists the per-repo entry under `adapters.github.config.repoModes`
 * (mirror of Slice C's schema field). Returns the new resolved mode so
 * the SPA can reconcile without a re-fetch.
 */
async function handleSetMode(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  owner: string,
  name: string,
): Promise<boolean> {
  const fullName = `${owner}/${name}`;
  let body: SetModeBody;
  try {
    body = ((await readJsonBody(req)) ?? {}) as SetModeBody;
  } catch {
    sendJson(res, 400, { error: "invalid_body" });
    return true;
  }
  // `null` is a valid "clear the override" signal. Anything else has to
  // be one of the three enum strings — reject typos rather than silently
  // dropping them.
  let mode: GithubRepoMode | null;
  if (body.mode === null) {
    mode = null;
  } else if (isGithubRepoMode(body.mode)) {
    mode = body.mode as GithubRepoMode;
  } else {
    sendJson(res, 400, {
      error: "invalid_mode",
      allowed: ["dossier", "full", "both", null],
    });
    return true;
  }

  const configPath = resolveConfigPath();
  const { changed } = await setGithubRepoMode(configPath, fullName, mode);
  if (changed) await tryReload(ctx.opts, ctx.logger);
  const snapshot = await readGithubModeSnapshot(configPath);
  const resolved = resolveGithubRepoMode(snapshot, fullName);
  sendJson(res, 200, {
    repo: fullName,
    mode: resolved,
    adapterMode: snapshot.adapterMode,
    modeOverride: snapshot.repoModes[fullName] !== undefined,
    changed,
  });
  return true;
}

async function handleDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  owner: string,
  name: string,
): Promise<boolean> {
  const fullName = `${owner}/${name}`;
  const purgeFlag = ctx.url.searchParams.get("purge");
  const purge = purgeFlag === "true" || purgeFlag === "1";
  const configPath = resolveConfigPath();
  const { removed } = await removeGithubRepo(configPath, fullName);
  if (removed) await tryReload(ctx.opts, ctx.logger);

  let memoriesPurged: number | undefined;
  if (purge) {
    // engram doesn't expose a prefix-delete API today. The MCP
    // kb_delete tool deletes by exact source_id. We scan the source
    // by querying with `source: github`, then delete chunks whose
    // source_id starts with `github:<owner>/<name>:`. Capped at 500
    // per pass because engram's search caps there too — the route
    // returns the count so the UI can iterate if needed.
    const engram = ctx.opts.engram;
    if (engram && typeof engram.delete === "function") {
      const prefix = `github:${fullName}:`;
      let removedCount = 0;
      try {
        // We need to walk all source_ids that start with the prefix.
        // engram.search returns chunks with their source_id in the
        // metadata bag — but the engram search shape (EngramMemory)
        // doesn't expose source_id directly. Today engram uses the
        // adapter-emitted source_id as the row's `id`, so kb_delete
        // by-id works. We grab chunks broadly via `source: github`
        // and filter client-side.
        const chunks = await engram.search({
          query: "*",
          source: "github",
          limit: 500,
          ...(ctx.opts.taxonomy ? {} : {}),
        });
        for (const chunk of chunks) {
          const md = chunk.metadata ?? {};
          const sourceId = typeof md["source_id"] === "string"
            ? (md["source_id"] as string)
            : typeof md["sourceId"] === "string"
              ? (md["sourceId"] as string)
              : undefined;
          if (typeof sourceId === "string" && sourceId.startsWith(prefix)) {
            // eslint-disable-next-line no-await-in-loop
            const r = await engram.delete({ sourceId });
            removedCount += r.deleted ?? 0;
          }
        }
      } catch (err) {
        ctx.logger.warn("api.dashboard_github_repos.purge_failed", {
          repo: fullName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      memoriesPurged = removedCount;
    } else {
      memoriesPurged = 0;
    }
  }

  sendJson(res, 200, {
    repo: fullName,
    removed,
    ...(purge ? { memoriesPurged: memoriesPurged ?? 0 } : {}),
  });
  return true;
}

/**
 * Mint a `github-sync` job, enqueue work that calls the in-process
 * `ingest_repo` MCP tool synchronously against the github URL. Keeping
 * the work behind enqueue() means the registry's concurrency cap
 * (`MAX_CONCURRENT_JOBS`) still applies — two parallel "Sync all
 * selected" clicks won't fan out and OOM the box.
 */
function enqueueGithubSyncJob(
  ctx: RouteContext,
  fullName: string,
  opts: { mode?: GithubRepoMode } = {},
): { id: string } {
  const job = jobs.create({
    kind: "github-sync",
  });
  // Stash the repo + resolved mode on progress so the Jobs page (and
  // GET /repos) can surface "Syncing as Dossier…" without re-reading
  // the config.
  jobs.progress(job.id, {
    repo: fullName,
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  const work = async (): Promise<unknown> => {
    const traceId = randomUUID();
    const toolCtx: ToolContext = {
      taxonomy: ctx.opts.taxonomy,
      memoryTypes: ctx.opts.memoryTypes,
      logger: ctx.logger.child({
        component: "github-sync",
        repo: fullName,
        ...(opts.mode ? { mode: opts.mode } : {}),
        traceId,
      }),
      engram: ctx.opts.engram,
      ...(ctx.opts.llmRouter ? { llmRouter: ctx.opts.llmRouter } : {}),
      traceId,
    };
    // The `mode` field maps onto Slice B's ingest_repo input. The
    // parser strips it gracefully if the running ingest_repo build
    // doesn't yet accept it (e.g. before Slice B merges) — the call
    // still runs in full-source mode and the dashboard remains
    // functional.
    const input = ingestRepo.inputSchema.parse({
      path: `https://github.com/${fullName}.git`,
      project: "default",
      tags: [`github:${fullName}`],
      ...(opts.mode ? { mode: opts.mode } : {}),
      // Run inline within our github-sync job so we don't nest jobs
      // (ingest_repo's async path would create its own job entry).
      async: false,
    });
    return ingestRepo.handler(input, toolCtx);
  };
  jobs.enqueue(job.id, work);
  return { id: job.id };
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
