/**
 * Tiny HTTP API that serves widget-shaped JSON for the Cortex dashboard.
 * Built on `node:http` for the same reasons as the webhook receiver —
 * small surface, no framework dep, easy to keep aligned with the MCP
 * tool context.
 *
 * Routing model: each URL prefix lives in its own file under `routes/`.
 * Every route handler has the same shape: `handle(req, res, ctx)` that
 * returns `true` when the URL was matched (success or 4xx/5xx alike),
 * `false` to fall through to the next handler. The dispatcher below
 * iterates the route list; the first to return `true` wins. If none
 * match, the dispatcher sends 404.
 *
 * Want to add an endpoint? Find the right file under `routes/` (or
 * create a new one — keep one file per URL prefix), then list it in
 * `ROUTES` below. The single-file dispatcher means you can't forget to
 * wire a handler — TypeScript will tell you if the import is missing.
 *
 * Security posture: binds to `127.0.0.1` by default (see ADR-015). CORS
 * is enabled only for localhost and chrome-extension origins; production
 * deployments terminate TLS in front.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { Logger } from "@onenomad/przm-cortex-core";
import type { SourceAdapter } from "@onenomad/przm-cortex-core";
import { handleIssue } from "./cookie-session.js";
import { setCors, sendJson } from "./http.js";
import { apiAuthOk } from "./auth.js";
import type { RouteContext, RouteHandler } from "./route-context.js";
import { buildWidgetRegistry } from "./widgets/index.js";
import type { Widget, WidgetContext } from "./types.js";
import type { HeartbeatWriter } from "../heartbeat.js";
import type { ReloadResult } from "../hot-reload.js";
import { TaxonomyCache } from "../taxonomy-cache.js";

import * as healthRoute from "./routes/health.js";
import * as dashboardAssetsRoute from "./routes/dashboard-assets.js";
import * as layoutRoute from "./routes/layout.js";
import * as widgetsRoute from "./routes/widgets.js";
import * as workspacesRoute from "./routes/workspaces.js";
import * as setupRoute from "./routes/setup.js";
import * as wizardsRoute from "./routes/wizards.js";
import * as configRoute from "./routes/config.js";
import * as workspaceFilesRoute from "./routes/workspace-files.js";
import * as workspaceDocsRoute from "./routes/workspace-docs.js";
import * as statusRoute from "./routes/status.js";
import * as adminMemoryRoute from "./routes/admin-memory.js";
import * as adminBackupRoute from "./routes/admin-backup.js";
import * as typesRoute from "./routes/types.js";
import * as reloadRoute from "./routes/reload.js";
import * as logsRoute from "./routes/logs.js";
import * as mcpToolsRoute from "./routes/mcp-tools.js";
import * as modulesRoute from "./routes/modules.js";
import * as adaptersRoute from "./routes/adapters.js";
import * as authGithubRoute from "./routes/auth-github.js";
import * as dashboardAuthRoute from "./routes/dashboard-auth.js";
import * as dashboardWorkspacesRoute from "./routes/dashboard-workspaces.js";
import * as dashboardIdentityRoute from "./routes/dashboard-identity.js";
import * as dashboardWizardRoute from "./routes/dashboard-wizard.js";
import * as dashboardAdaptersRoute from "./routes/dashboard-adapters.js";
import * as dashboardLogsRoute from "./routes/dashboard-logs.js";
import * as dashboardJobsRoute from "./routes/dashboard-jobs.js";
import * as dashboardStatsRoute from "./routes/dashboard-stats.js";
import * as dashboardIngestRoute from "./routes/dashboard-ingest.js";
import * as dashboardGithubReposRoute from "./routes/dashboard-github-repos.js";

export interface DashboardApiOptions extends WidgetContext {
  host?: string;
  port: number;
  logger: Logger;
  /**
   * Live heartbeat writer. The API exposes its snapshot via
   * `/api/status` so the dashboard's Status page can render uptime,
   * memory health, and per-adapter sync state without re-reading the
   * file from disk.
   */
  heartbeat?: HeartbeatWriter;
  /**
   * Live adapter registry so the dashboard can trigger a one-off sync
   * from the Adapters page. Keyed by adapter id. Omit to disable the
   * /api/adapters/:id/sync endpoint (returns 503).
   */
  adapters?: Record<string, SourceAdapter>;
  /**
   * Hot-reload hook — rebuild LLM router + adapter registry +
   * scheduler from the live config file. Write endpoints call this
   * after a successful mutation so toggles/schedule/wizard saves
   * take effect without a container restart.
   */
  reload?: () => Promise<ReloadResult>;
  /**
   * Path to the `dashboard.yaml` template. Re-read on every `/api/layout`
   * request so users can edit and refresh without bouncing the server.
   * If omitted, `/api/layout` returns the built-in delivery preset.
   */
  layoutPath?: string;
  /**
   * Live per-workspace taxonomy cache. When present, the MCP console
   * uses it to resolve the CURRENTLY active workspace's taxonomy on
   * every invoke — instead of the process-wide bootstrap taxonomy
   * that was loaded once at startup. Without this, the console
   * returns stale projects when the user switches workspaces without
   * restarting cortex.
   */
  taxonomyCache?: TaxonomyCache;
  /**
   * ADR-019 Phase 1 — SQLite cache for the priorities widget. When
   * provided, requests to `/api/widgets/priorities` are served from
   * cache on hit, computed on miss with the result written back.
   * Optional: tests pass `undefined` to exercise the registry without
   * dragging the cache-sqlite package (and its `node:sqlite` import)
   * into the vite/vitest transform graph.
   */
  cache?: import("@onenomad/przm-cortex-cache-sqlite").CacheStorage;
}

export interface DashboardApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  boundPort(): number | undefined;
  routes(): ReadonlyArray<string>;
}

/**
 * Route table. Order matters only when two handlers would both match
 * the same URL — pick the more-specific one first. Today no two
 * handlers overlap, but if you add one that does, put it above the
 * broader handler here.
 */
const ROUTES: ReadonlyArray<{ name: string; handle: RouteHandler }> = [
  { name: "layout", handle: layoutRoute.handle },
  { name: "widgets", handle: widgetsRoute.handle },
  { name: "workspace-files", handle: workspaceFilesRoute.handle },
  { name: "workspace-docs", handle: workspaceDocsRoute.handle },
  { name: "workspaces", handle: workspacesRoute.handle },
  { name: "setup", handle: setupRoute.handle },
  { name: "wizards", handle: wizardsRoute.handle },
  { name: "config", handle: configRoute.handle },
  { name: "status", handle: statusRoute.handle },
  { name: "admin-memory", handle: adminMemoryRoute.handle },
  { name: "admin-backup", handle: adminBackupRoute.handle },
  { name: "types", handle: typesRoute.handle },
  { name: "reload", handle: reloadRoute.handle },
  { name: "logs", handle: logsRoute.handle },
  { name: "mcp-tools", handle: mcpToolsRoute.handle },
  { name: "modules", handle: modulesRoute.handle },
  { name: "adapters", handle: adaptersRoute.handle },
  { name: "auth-github", handle: authGithubRoute.handle },
  { name: "dashboard-auth", handle: dashboardAuthRoute.handle },
  { name: "dashboard-workspaces", handle: dashboardWorkspacesRoute.handle },
  { name: "dashboard-identity", handle: dashboardIdentityRoute.handle },
  { name: "dashboard-wizard", handle: dashboardWizardRoute.handle },
  { name: "dashboard-adapters", handle: dashboardAdaptersRoute.handle },
  { name: "dashboard-logs", handle: dashboardLogsRoute.handle },
  { name: "dashboard-jobs", handle: dashboardJobsRoute.handle },
  { name: "dashboard-stats", handle: dashboardStatsRoute.handle },
  { name: "dashboard-ingest", handle: dashboardIngestRoute.handle },
  { name: "dashboard-github-repos", handle: dashboardGithubReposRoute.handle },
];

export function createDashboardApi(opts: DashboardApiOptions): DashboardApi {
  const host = opts.host ?? "127.0.0.1";
  const widgetCtx: WidgetContext = {
    logger: opts.logger,
    engram: opts.engram,
    ...(opts.llmRouter ? { llmRouter: opts.llmRouter } : {}),
    taxonomy: opts.taxonomy,
    memoryTypes: opts.memoryTypes,
  };

  // ADR-019 Phase 1 — registry built per-instance so the optional cache
  // is wired in at construction time rather than module-load time. Tests
  // omit `opts.cache`; production passes a real cache from startup.
  const widgets: readonly Widget[] = buildWidgetRegistry(opts.cache);
  const widgetsByName: ReadonlyMap<string, Widget> = new Map(
    widgets.map((w) => [w.name, w]),
  );

  let server: Server | undefined;

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const reqId = randomUUID();
    const logger = opts.logger.child({ reqId });
    const origin = req.headers.origin;
    setCors(res, typeof origin === "string" ? origin : undefined);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}`);
    const pathname = url.pathname;

    // Public health probe — bypasses auth entirely so Fly's machine
    // health probe (and any upstream load balancer) can hit it.
    if (await healthRoute.handle(req, res, makeCtx(opts, logger, url, pathname, widgets, widgetsByName, widgetCtx))) {
      return;
    }

    // Dashboard SPA static assets — bypass auth so the login UI itself
    // can load for unauthenticated users. Per-route auth on `/api/*`
    // is what actually guards the data; serving HTML/JS/CSS does not
    // expose anything sensitive. Register here, BEFORE `apiAuthOk`.
    if (
      await dashboardAssetsRoute.handle(
        req,
        res,
        makeCtx(opts, logger, url, pathname, widgets, widgetsByName, widgetCtx),
      )
    ) {
      return;
    }

    // Cookie-handoff bootstrap: `/cortex-session/issue?token=...`
    // verifies a short-lived signed token from pyre-web, sets the
    // session cookie, and redirects. Public path because the token IS
    // the auth — anything past this can rely on the cookie.
    if (await handleIssue(req, res, logger)) {
      return;
    }

    // Dashboard login: exchange a raw token for a `cortex_dash_sid`
    // cookie. Must run BEFORE `apiAuthOk` because the whole point of
    // login is to acquire the credential the gate is checking for.
    // Subsequent /api/dashboard/* requests sit behind the gate and
    // route through `requireDashboardAuth` for scope + CSRF checks.
    if (await dashboardAuthRoute.handleLogin(req, res, logger)) {
      return;
    }

    // Three-track auth. Cookie, bearer, or gateway-secret — any one
    // passes. Cookie covers browser sessions (pyre-web → JWT handoff).
    // Bearer covers direct-client API access (Claude Code's MCP).
    // Gateway secret covers server-to-server proxy callers.
    //
    // `/api/dashboard/*` carries its own auth (token-hash bearer or
    // `cortex_dash_sid` cookie) enforced by `requireDashboardAuth`, so
    // it bypasses this gate. Without this skip a deployment with
    // PRZM_CORTEX_API_AUTH_TOKEN set would block the dashboard's own
    // login round-trip before the route ever ran.
    if (!pathname.startsWith("/api/dashboard/") && !apiAuthOk(req)) {
      logger.warn("api.auth_rejected", {
        path: pathname,
        ip: req.socket.remoteAddress ?? "unknown",
      });
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end("unauthorized");
      return;
    }

    const ctx = makeCtx(opts, logger, url, pathname, widgets, widgetsByName, widgetCtx);

    // First route to return true wins.
    for (const route of ROUTES) {
      if (await route.handle(req, res, ctx)) return;
    }

    sendJson(res, 404, { error: "not found" });
  };

  return {
    async start(): Promise<void> {
      server = createServer((req, res) => {
        void handle(req, res).catch((err) => {
          opts.logger.error("api.unhandled", {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) {
            sendJson(res, 500, { error: "internal error" });
          } else {
            res.end();
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(opts.port, host, () => {
          server!.off("error", reject);
          const addr = server!.address();
          const port =
            addr && typeof addr !== "string" ? addr.port : opts.port;
          opts.logger.info("api.listening", {
            host,
            port,
            widgets: widgets.length,
            routes: ROUTES.length,
          });
          if (host !== "127.0.0.1" && host !== "localhost") {
            opts.logger.warn("api.non_local_bind", {
              host,
              hint:
                "Dashboard API is reachable beyond localhost. This is fine over Tailscale, risky over a public network.",
            });
          }
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (!server) return;
      const s = server;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
      server = undefined;
    },

    boundPort(): number | undefined {
      const addr = server?.address();
      return addr && typeof addr !== "string" ? addr.port : undefined;
    },

    routes(): ReadonlyArray<string> {
      return [
        "/health",
        "GET /_dashboard/*",
        "/api/layout",
        "/api/widgets",
        ...widgets.map((w) => `/api/widgets/${w.name}`),
        "GET /api/workspaces",
        "POST /api/workspaces",
        "POST /api/workspaces/switch",
        "DELETE /api/workspaces/:slug",
        "GET /api/config",
        "GET /api/config/adapters",
        "GET /api/config/adapters/:id",
        "POST /api/config/adapters/:id/toggle",
        "POST /api/config/adapters/:id/schedule",
        "GET /api/config/providers",
        "GET /api/config/providers/:id",
        "POST /api/config/providers/:id/toggle",
        "GET /api/workspace-files/:name",
        "PUT /api/workspace-files/:name",
        "GET /api/status",
        "GET /api/logs",
        "GET /api/logs/stream",
        "GET /api/mcp/tools",
        "POST /api/mcp/tools/:name/invoke",
        "POST /api/adapters/:id/sync",
        "POST /api/reload",
        "GET /api/modules",
        "POST /api/modules/install",
        "DELETE /api/modules/:name",
        "GET /api/setup/state",
        "GET /api/wizards",
        "GET /api/wizards/:id",
        "POST /api/wizards/:id/discover",
        "POST /api/wizards/:id",
        "GET /api/admin/memory/export",
        "POST /api/admin/memory/wipe",
        "POST /api/admin/backup/dump",
        "POST /api/admin/backup/restore",
        "GET /api/types",
        "POST /api/types",
        "DELETE /api/types/:slug",
        "GET /api/auth/github/status",
        "POST /api/auth/github/start",
        "POST /api/auth/github/complete",
        "POST /api/dashboard/auth/login",
        "POST /api/dashboard/auth/logout",
        "GET /api/dashboard/auth/whoami",
        "GET /api/dashboard/workspaces",
        "POST /api/dashboard/workspaces/switch",
        "POST /api/dashboard/workspaces/create",
        "GET /api/dashboard/identity",
        "POST /api/dashboard/identity/self",
        "POST /api/dashboard/identity/job-profile",
        "GET /api/dashboard/wizard/list",
        "GET /api/dashboard/wizard/spec/:moduleKind/:moduleId",
        "POST /api/dashboard/wizard/run",
        "GET /api/dashboard/adapters",
        "GET /api/dashboard/adapters/:id",
        "POST /api/dashboard/adapters/:id/pause",
        "POST /api/dashboard/adapters/:id/resume",
        "POST /api/dashboard/adapters/:id/trigger-fetch",
        "DELETE /api/dashboard/adapters/:id",
        "GET /api/dashboard/logs",
        "GET /api/dashboard/jobs",
        "GET /api/dashboard/jobs/:jobId",
        "GET /api/dashboard/stats",
        "POST /api/dashboard/ingest/url",
        "POST /api/dashboard/ingest/file",
        "POST /api/dashboard/ingest/content",
        "GET /api/dashboard/github/repos",
        "POST /api/dashboard/github/repos/sync",
        "POST /api/dashboard/github/repos/:owner/:name/sync",
        "DELETE /api/dashboard/github/repos/:owner/:name",
      ];
    },
  };
}

function makeCtx(
  opts: DashboardApiOptions,
  logger: Logger,
  url: URL,
  pathname: string,
  widgets: readonly Widget[],
  widgetsByName: ReadonlyMap<string, Widget>,
  widgetCtx: WidgetContext,
): RouteContext {
  return {
    opts,
    logger,
    url,
    pathname,
    widgets,
    widgetsByName,
    widgetCtx,
  };
}
