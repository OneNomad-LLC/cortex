import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Logger } from "@onenomad/cortex-core";
import type { DeviceCodeGrant } from "@onenomad/cortex-github-auth";
import {
  createDeviceFlow,
  defaultTokenPath as defaultGithubTokenPath,
  tryReadGithubToken,
  writeGithubToken,
} from "@onenomad/cortex-github-auth";
import { applyWizardResult } from "../cli/config-mutation.js";
import { resolveConfigPath } from "../cli/config-path.js";
import { discoverForWizard } from "../cli/discovery.js";
import { findRepoRoot } from "../cli/dotenv.js";
import { findWizard, listWizards } from "../cli/wizard-registry.js";
import {
  createWorkspace,
  findWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  removeWorkspace,
  switchWorkspace,
  validateSlug,
  type Workspace,
} from "../cli/workspace/manager.js";
import { readState } from "../cli/workspace/state.js";
import { loadCortexConfig, resolveLocalFirst } from "../config.js";
import {
  type DashboardLayout,
  loadDashboardLayout,
  resolveLayout,
} from "./layout.js";
import { buildWidgetRegistry } from "./widgets/index.js";
import { handleWorkspaceDocs } from "./workspace-docs.js";
import type { Widget, WidgetContext } from "./types.js";
import type { HeartbeatWriter } from "../heartbeat.js";
import { getSharedLogBus, type LogLine } from "../log-bus.js";
import { ALL_TOOLS } from "../mcp/tools/index.js";
import type { AnyMcpTool, ToolContext } from "../mcp/tool.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { PersonaClient } from "../clients/persona.js";
import type { SourceAdapter } from "@onenomad/cortex-core";
import { runSync } from "../sync.js";
import type { ReloadResult } from "../hot-reload.js";
import { getSharedBrowserBridge } from "../browser-bridge.js";
import { TaxonomyCache } from "../taxonomy-cache.js";
import {
  installModule,
  type InstallEvent,
} from "../cli/module-install.js";
import {
  listPrivateModulesFromConfig,
  removePrivateModule,
} from "../cli/config-mutation.js";
import { existsSync } from "node:fs";

export interface DashboardApiOptions extends WidgetContext {
  host?: string;
  port: number;
  logger: Logger;
  /**
   * Live heartbeat writer. The API exposes its snapshot via
   * `/api/status` so the dashboard's Status page can render uptime,
   * engram/persona health, and per-adapter sync state without
   * re-reading the file from disk.
   */
  heartbeat?: HeartbeatWriter;
  /**
   * Persona client passed through to MCP console tool invocations so
   * tools that take a full ToolContext (all of them) can execute. Made
   * optional so tests that don't need MCP can omit it; the console
   * endpoint will 503 if it's not wired.
   */
  persona?: PersonaClient;
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
  cache?: import("@onenomad/cortex-cache-sqlite").CacheStorage;
}

export interface DashboardApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  boundPort(): number | undefined;
  routes(): ReadonlyArray<string>;
}

/**
 * Tiny HTTP API that serves widget-shaped JSON for the Cortex dashboard.
 * Built on `node:http` for the same reasons as the webhook receiver —
 * small surface, no framework dep, easy to keep aligned with the MCP
 * tool context.
 *
 * Security posture: binds to `127.0.0.1` by default (see ADR-015). CORS
 * is enabled only for the dashboard dev server (http://localhost:3000)
 * and the sibling bind; production deployments terminate TLS in front.
 */
export function createDashboardApi(opts: DashboardApiOptions): DashboardApi {
  const host = opts.host ?? "127.0.0.1";
  const widgetCtx: WidgetContext = {
    logger: opts.logger,
    engram: opts.engram,
    ...(opts.llmRouter ? { llmRouter: opts.llmRouter } : {}),
    taxonomy: opts.taxonomy,
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

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, version: 1, widgets: widgets.length });
      return;
    }

    if (req.method === "GET" && pathname === "/api/layout") {
      try {
        const raw: DashboardLayout = opts.layoutPath
          ? await loadDashboardLayout(opts.layoutPath)
          : { role: "delivery", widgets: [] };
        const resolved = resolveLayout(raw);
        // Surface workspace name so the dashboard header can render
        // which bundle of config is currently driving the UI. Undefined
        // means the user hasn't adopted workspaces yet — the dashboard
        // handles that case by hiding the badge.
        const workspace = await getActiveWorkspace().catch(() => undefined);
        sendJson(res, 200, {
          ...resolved,
          ...(workspace ? { workspace: workspace.slug } : {}),
        });
      } catch (err) {
        logger.warn("api.layout.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/widgets") {
      sendJson(res, 200, {
        widgets: widgets.map((w) => ({
          name: w.name,
          description: w.description,
        })),
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/widgets/")) {
      const name = pathname.slice("/api/widgets/".length);
      const widget: Widget | undefined = widgetsByName.get(name);
      if (!widget) {
        sendJson(res, 404, { error: `widget '${name}' not found` });
        return;
      }
      // Phase 1b — per-request workspace resolution. The dashboard sends
      // `?workspace=<slug>` (1a) so each widget request can scope to the
      // workspace the UI is currently viewing, regardless of the global
      // active-pointer. Falls back to getActiveWorkspace() for clients
      // that don't pass the param (CLI tooling, legacy callers).
      // TODO(v8): consolidate with the MCP-side AsyncLocalStorage
      // workspace store from session-context.ts (ADR-018) to avoid
      // duplicating the bind pattern.
      const requestedSlug = url.searchParams.get("workspace")?.trim();
      let requestWorkspace: Workspace | undefined;
      if (requestedSlug) {
        requestWorkspace = await findWorkspace(requestedSlug);
        if (!requestWorkspace) {
          sendJson(res, 400, {
            error: `unknown workspace '${requestedSlug}'`,
          });
          return;
        }
      } else {
        requestWorkspace = await getActiveWorkspace().catch(() => undefined);
      }
      const started = Date.now();
      try {
        const payload = await widget.handler(url.searchParams, {
          ...widgetCtx,
          ...(requestWorkspace ? { workspace: requestWorkspace } : {}),
          logger: logger.child({
            widget: name,
            ...(requestWorkspace ? { workspace: requestWorkspace.slug } : {}),
          }),
        });
        logger.info("api.widget.ok", {
          widget: name,
          ms: Date.now() - started,
        });
        sendJson(res, 200, payload);
      } catch (err) {
        logger.warn("api.widget.failed", {
          widget: name,
          error: err instanceof Error ? err.message : String(err),
          ms: Date.now() - started,
        });
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (pathname === "/api/workspaces" || pathname.startsWith("/api/workspaces/")) {
      await handleWorkspaces(req, res, logger);
      return;
    }

    if (pathname === "/api/setup/state") {
      await handleSetupState(res, logger);
      return;
    }

    if (pathname === "/api/wizards" || pathname.startsWith("/api/wizards/")) {
      await handleWizards(req, res, opts, logger);
      return;
    }

    if (pathname === "/api/config" || pathname.startsWith("/api/config/")) {
      await handleConfig(req, res, pathname, opts, logger);
      return;
    }

    if (pathname.startsWith("/api/workspace-files/")) {
      await handleWorkspaceFiles(req, res, pathname, opts, logger);
      return;
    }

    if (
      pathname === "/api/workspace-docs" ||
      pathname.startsWith("/api/workspace-docs/")
    ) {
      await handleWorkspaceDocs(req, res, pathname, logger);
      return;
    }

    if (pathname === "/api/status") {
      await handleStatus(res, opts.heartbeat, logger);
      return;
    }

    if (req.method === "POST" && pathname === "/api/reload") {
      const reloaded = await tryReload(opts, logger);
      if (reloaded === false) {
        sendJson(res, 503, {
          error:
            "hot reload not wired in this build — restart the container to apply config changes",
        });
        return;
      }
      sendJson(res, 200, { reloaded: true, detail: reloaded });
      return;
    }

    if (pathname === "/api/logs") {
      await handleLogsRecent(req, res);
      return;
    }

    if (pathname === "/api/logs/stream") {
      handleLogsStream(req, res, logger);
      return;
    }

    if (pathname === "/api/mcp/tools" || pathname.startsWith("/api/mcp/tools/")) {
      await handleMcpTools(req, res, pathname, opts, logger);
      return;
    }

    if (pathname === "/api/modules" || pathname.startsWith("/api/modules/")) {
      await handleModules(req, res, pathname, logger);
      return;
    }

    const syncMatch = pathname.match(/^\/api\/adapters\/([^/]+)\/sync$/);
    if (req.method === "POST" && syncMatch) {
      const id = decodeURIComponent(syncMatch[1]!);
      await handleAdapterSync(req, res, id, opts, logger);
      return;
    }

    if (pathname.startsWith("/api/auth/github/")) {
      await handleGithubAuth(req, res, logger);
      return;
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

      // Upgrade `/ws/browser` connections to the browser bridge so
      // the extension can drive tools on the user's tabs. Shares the
      // dashboard API port — one listener, one surface.
      const browserBridge = getSharedBrowserBridge(opts.logger);
      server.on("upgrade", (req, socket, head) => {
        const handled = browserBridge.handleUpgrade(req, socket, head);
        if (!handled) {
          // Not our upgrade path — reject cleanly rather than leak
          // the socket.
          socket.destroy();
        }
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
        "POST /api/config/adapters/:id/schedule",
        "POST /api/reload",
        "GET /api/modules",
        "POST /api/modules/install",
        "DELETE /api/modules/:name",
      ];
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("body is not valid JSON");
  }
}

async function handleWorkspaces(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  try {
    // GET /api/workspaces — list
    if (req.method === "GET" && path === "/api/workspaces") {
      const [workspaces, state] = await Promise.all([
        listWorkspaces(),
        readState(),
      ]);
      sendJson(res, 200, {
        active: state.activeWorkspace ?? null,
        workspaces: workspaces.map((w) => ({
          slug: w.slug,
          path: w.path,
          active: state.activeWorkspace === w.slug,
        })),
      });
      return;
    }

    // POST /api/workspaces/switch — flip pointer
    if (req.method === "POST" && path === "/api/workspaces/switch") {
      const body = (await readJsonBody(req)) as { slug?: string };
      if (!body.slug) {
        sendJson(res, 400, { error: "body.slug required" });
        return;
      }
      const ws = await switchWorkspace(body.slug);
      sendJson(res, 200, {
        slug: ws.slug,
        path: ws.path,
        warning:
          "State updated. Restart `cortex start` so the running daemon loads this workspace's memory and config.",
      });
      return;
    }

    // POST /api/workspaces — create
    if (req.method === "POST" && path === "/api/workspaces") {
      const body = (await readJsonBody(req)) as {
        slug?: string;
        fromPath?: string;
        activate?: boolean;
      };
      if (!body.slug) {
        sendJson(res, 400, { error: "body.slug required" });
        return;
      }
      const validated = validateSlug(body.slug);
      if (!validated.ok) {
        sendJson(res, 400, { error: validated.reason });
        return;
      }
      const ws = await createWorkspace({
        slug: body.slug,
        ...(body.fromPath ? { fromPath: body.fromPath } : {}),
      });
      const state = await readState();
      let activated = false;
      if (!state.activeWorkspace || body.activate) {
        await switchWorkspace(ws.slug);
        activated = true;
      }
      sendJson(res, 201, {
        slug: ws.slug,
        path: ws.path,
        activated,
      });
      return;
    }

    // DELETE /api/workspaces/:slug?confirm=true — destructive
    if (req.method === "DELETE" && path.startsWith("/api/workspaces/")) {
      const slug = decodeURIComponent(path.slice("/api/workspaces/".length));
      const confirm = url.searchParams.get("confirm") === "true";
      if (!confirm) {
        sendJson(res, 400, {
          error:
            "destructive — pass ?confirm=true to delete the workspace directory",
        });
        return;
      }
      const existing = await findWorkspace(slug);
      if (!existing) {
        sendJson(res, 404, { error: `workspace '${slug}' not found` });
        return;
      }
      await removeWorkspace(slug);
      sendJson(res, 200, { slug, removed: true });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    logger.warn("api.workspaces.failed", {
      method: req.method,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function setCors(res: ServerResponse, origin: string | undefined): void {
  // Accept: localhost (dashboard dev), chrome-extension://<id> (the
  // Cortex browser extension ingesting page content). Everything else
  // falls back to `*` — the localhost bind is the real security
  // boundary, not the origin check.
  const allow =
    origin &&
    (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      /^(chrome|moz|safari-web)-extension:\/\/[a-zA-Z0-9-]+$/.test(origin))
      ? origin
      : "*";
  res.setHeader("access-control-allow-origin", allow);
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, x-cortex-source",
  );
  res.setHeader("vary", "origin");
}

/**
 * GitHub device-flow endpoints for the dashboard "Connect GitHub"
 * button. Three operations:
 *
 *   GET  /api/auth/github/status     — is a token stored?
 *   POST /api/auth/github/start      — kick off device flow
 *   POST /api/auth/github/complete   — finalize (poll GitHub once,
 *                                      store token on success)
 *
 * The dashboard polls `/complete` every ~3s from the moment the user
 * sees the short code until GitHub reports approved / denied /
 * expired. That keeps the polling logic in the browser where we can
 * show progress instead of tying up a server request.
 */
const pendingGithubGrants = new Map<string, DeviceCodeGrant>();
const GITHUB_CLIENT_ID =
  process.env.CORTEX_GITHUB_CLIENT_ID ?? "Ov23lidpaSywVEHtcXa4";

async function handleGithubAuth(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/auth/github/status") {
      const token = await tryReadGithubToken();
      if (!token) {
        sendJson(res, 200, { authenticated: false });
        return;
      }
      sendJson(res, 200, {
        authenticated: true,
        scopes: token.scopes,
        grantedAt: token.grantedAt,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/github/start") {
      const body = (await readJsonBody(req)) as {
        scopes?: string[];
      };
      const scopes = body.scopes ?? ["repo"];
      const flow = createDeviceFlow({
        clientId: GITHUB_CLIENT_ID,
        scopes,
      });
      const grant = await flow.start();
      pendingGithubGrants.set(grant.deviceCode, grant);
      // Reap expired grants so the map doesn't grow forever if the
      // user abandons the flow.
      for (const [code, g] of pendingGithubGrants) {
        if (g.expiresAt.getTime() < Date.now()) {
          pendingGithubGrants.delete(code);
        }
      }
      sendJson(res, 200, {
        deviceCode: grant.deviceCode,
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        expiresAt: grant.expiresAt.toISOString(),
        pollIntervalSeconds: grant.pollIntervalSeconds,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/github/complete") {
      const body = (await readJsonBody(req)) as { deviceCode?: string };
      if (!body.deviceCode) {
        sendJson(res, 400, { error: "deviceCode required" });
        return;
      }
      const grant = pendingGithubGrants.get(body.deviceCode);
      if (!grant) {
        sendJson(res, 410, {
          status: "expired",
          error: "device code not found — it may have expired or already been consumed",
        });
        return;
      }
      const flow = createDeviceFlow({ clientId: GITHUB_CLIENT_ID });
      // One-shot poll: reuse the poll logic but adapt it to "try once
      // and report status" rather than "block until done". Simplest
      // path is to wrap the poll in a promise race against a 0-delay
      // timer, but that still sleeps `pollIntervalSeconds`. The
      // dashboard already waits ~3s between polls on its own, so
      // instead we do a single token request inline and handle the
      // "authorization_pending" state as a normal not-yet-done.
      const resp = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            device_code: grant.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }).toString(),
        },
      );
      const json = (await resp.json().catch(() => ({}))) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (json.access_token) {
        pendingGithubGrants.delete(body.deviceCode);
        const scopes = (json.scope ?? "").split(/[\s,]+/).filter(Boolean);
        await writeGithubToken(
          {
            accessToken: json.access_token,
            scopes,
            clientId: GITHUB_CLIENT_ID,
            grantedAt: new Date().toISOString(),
          },
          defaultGithubTokenPath(),
        );
        sendJson(res, 200, {
          status: "authorized",
          scopes,
        });
        return;
      }
      if (json.error === "authorization_pending" || json.error === "slow_down") {
        sendJson(res, 200, {
          status: "pending",
          hint:
            json.error === "slow_down"
              ? "GitHub asked us to slow down polling — wait a bit longer between tries."
              : undefined,
        });
        return;
      }
      if (json.error === "expired_token" || json.error === "access_denied") {
        pendingGithubGrants.delete(body.deviceCode);
        sendJson(res, 200, {
          status: json.error === "expired_token" ? "expired" : "denied",
        });
        return;
      }
      sendJson(res, 500, {
        status: "error",
        error: json.error ?? "unknown response from GitHub",
        detail: json.error_description ?? null,
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    logger.warn("api.github_auth.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * GET /api/setup/state — what the dashboard needs to decide whether to
 * show the first-run setup flow vs. the normal widget grid.
 *
 * "Configured" means: a workspace is active AND that workspace's
 * cortex.yaml has at least one enabled LLM provider. Adapters are
 * checked separately so the UI can prompt the user to enable one
 * without blocking the basic flow.
 */
async function handleSetupState(
  res: ServerResponse,
  logger: Logger,
): Promise<void> {
  try {
    const workspace = await getActiveWorkspace().catch(() => undefined);
    let hasLlmProvider = false;
    let enabledAdapters: string[] = [];
    if (workspace) {
      try {
        const cfg = await loadCortexConfig(
          resolveConfigPath(),
        );
        const providers = cfg.llm?.providers ?? {};
        hasLlmProvider = Object.values(providers).some(
          (p) => (p as { enabled?: boolean }).enabled === true,
        );
        enabledAdapters = Object.entries(cfg.adapters ?? {})
          .filter(([, entry]) => (entry as { enabled?: boolean }).enabled === true)
          .map(([id]) => id);
      } catch {
        // Config unreadable — treat as unconfigured.
      }
    }
    sendJson(res, 200, {
      workspace: workspace ? workspace.slug : null,
      workspacePath: workspace ? workspace.path : null,
      hasLlmProvider,
      enabledAdapters,
      needsSetup: !workspace || !hasLlmProvider,
    });
  } catch (err) {
    logger.warn("api.setup_state.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * GET  /api/wizards          — list every WizardModule spec
 * GET  /api/wizards/:id      — fetch one spec (for form rendering)
 * POST /api/wizards/:id      — apply a completed result
 *
 * The dashboard's setup page hits these to render forms from the same
 * WizardModule specs the CLI uses (ADR-014). Submit writes to the
 * active workspace's config via the shared config-mutation service.
 */
async function handleWizards(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DashboardApiOptions,
  logger: Logger,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/api/wizards") {
      const wizards = listWizards().map((w) => ({
        id: w.id,
        name: w.name,
        category: w.category,
        description: w.description,
      }));
      sendJson(res, 200, { wizards });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/wizards/")) {
      const id = decodeURIComponent(pathname.slice("/api/wizards/".length));
      const wizard = findWizard(id);
      if (!wizard) {
        sendJson(res, 404, { error: `wizard '${id}' not found` });
        return;
      }
      // The spec's `configSchema` is a Zod type — not JSON-serializable.
      // The dashboard doesn't need the schema itself to render a form;
      // the `steps` list carries all the shape info. Strip it out.
      sendJson(res, 200, {
        id: wizard.id,
        name: wizard.name,
        category: wizard.category,
        description: wizard.description,
        steps: wizard.steps.map((s) => ({ ...s, pattern: undefined })),
        secrets: wizard.secrets ?? [],
      });
      return;
    }

    if (
      req.method === "POST" &&
      pathname.startsWith("/api/wizards/") &&
      pathname.endsWith("/discover")
    ) {
      const id = decodeURIComponent(
        pathname.slice("/api/wizards/".length, -"/discover".length),
      );
      const wizard = findWizard(id);
      if (!wizard) {
        sendJson(res, 404, { error: `wizard '${id}' not found` });
        return;
      }
      const body = (await readJsonBody(req)) as {
        config?: Record<string, unknown>;
        secrets?: Record<string, string>;
      };
      const result = await discoverForWizard({
        wizardId: id,
        config: body.config ?? {},
        secrets: body.secrets ?? {},
        logger,
        repoRoot: findRepoRoot(process.cwd()),
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname.startsWith("/api/wizards/")) {
      const id = decodeURIComponent(pathname.slice("/api/wizards/".length));
      const wizard = findWizard(id);
      if (!wizard) {
        sendJson(res, 404, { error: `wizard '${id}' not found` });
        return;
      }
      const active = await getActiveWorkspace();
      if (!active) {
        sendJson(res, 400, {
          error:
            "no active workspace — create one via POST /api/workspaces before applying wizard results",
        });
        return;
      }

      const body = (await readJsonBody(req)) as {
        config?: Record<string, unknown>;
        secrets?: Record<string, string>;
      };

      const configInput = body.config ?? {};
      const parsed = wizard.configSchema.safeParse(configInput);
      if (!parsed.success) {
        sendJson(res, 400, {
          error: "config validation failed",
          issues: parsed.error.issues,
        });
        return;
      }

      const derivedTaxonomy = wizard.derivedTaxonomy?.(
        configInput as Record<string, unknown>,
      );

      const result = {
        moduleId: wizard.id,
        category: wizard.category,
        config: parsed.data,
        secrets: body.secrets ?? {},
        ...(derivedTaxonomy ? { derivedTaxonomy } : {}),
      };
      const applied = await applyWizardResult(
        { repoRoot: active.path },
        result,
      );
      // Also update process.env in-memory so the hot reload below
      // sees the new secret values. Without this the write lands on
      // disk but providers/adapters that need the key at init time
      // still see undefined until the next container restart.
      for (const [k, v] of Object.entries(result.secrets)) {
        if (typeof v === "string" && v.length > 0) {
          process.env[k] = v;
        }
      }
      const reloaded = await tryReload(opts, logger);
      sendJson(res, 200, {
        applied: true,
        filesWritten: applied.filesWritten,
        reloaded,
        restartRequired: !reloaded,
        warning: reloaded
          ? undefined
          : "Config written. Restart `cortex start` (or the sidecar) so the new settings take effect.",
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    logger.warn("api.wizards.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Config-surface endpoints powering the dashboard settings screens.
 *
 *   GET  /api/config                           — parsed + raw cortex.yaml
 *   GET  /api/config/adapters                  — all adapters with enabled state
 *   GET  /api/config/adapters/:id              — one adapter's current config
 *   POST /api/config/adapters/:id/toggle       — flip enabled
 *   GET  /api/config/providers                 — all providers with enabled state
 *   GET  /api/config/providers/:id             — one provider's current config
 *   POST /api/config/providers/:id/toggle      — flip enabled
 */
/**
 * GET /api/status — live health + uptime + per-adapter sync state.
 *
 * Reads straight from the in-process HeartbeatWriter so the dashboard
 * sees up-to-the-second numbers (the on-disk file only flushes every
 * 60s). If no heartbeat is wired in the response says `running: false`.
 */
async function handleStatus(
  res: ServerResponse,
  heartbeat: HeartbeatWriter | undefined,
  logger: Logger,
): Promise<void> {
  try {
    if (!heartbeat) {
      sendJson(res, 200, { running: false });
      return;
    }
    const snap = heartbeat.snapshot();
    sendJson(res, 200, { running: true, ...snap });
  } catch (err) {
    logger.warn("api.status.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * GET /api/logs?limit=N — recent lines from the in-memory ring buffer.
 * The SSE stream below doesn't replay history, so callers can hit this
 * first to backfill and then subscribe for live updates.
 */
async function handleLogsRecent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(2000, Number(limitRaw))) : 500;
  const lines = getSharedLogBus().recent(limit);
  sendJson(res, 200, { lines });
}

/**
 * GET /api/logs/stream — Server-Sent Events. Every new log line gets
 * flushed as a `data: <json>\n\n` message. Keeps the response open
 * indefinitely; the browser reconnects automatically if the tab
 * navigates or the socket drops.
 */
function handleLogsStream(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Preamble so proxies that sniff the first chunk see something.
  res.write(": connected\n\n");

  const bus = getSharedLogBus();
  const onLine = (line: LogLine): void => {
    try {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      // Writing after the client disconnected throws; cleanup runs below.
    }
  };
  bus.on("line", onLine);

  // Heartbeat every 15s so idle proxies don't close the connection.
  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      // ignored — cleanup handles disconnects
    }
  }, 15_000);
  keepalive.unref?.();

  req.on("close", () => {
    clearInterval(keepalive);
    bus.off("line", onLine);
    logger.debug("api.logs.stream_closed");
  });
}

/**
 * POST /api/adapters/:id/sync — manual, immediate ingestion run.
 *
 * Uses the already-running adapter registry, so it picks up whatever
 * config + secrets the server booted with. The heartbeat tracks the
 * run; the dashboard's Status page (and Adapters page) see counters
 * update in real time.
 */
async function handleAdapterSync(
  req: IncomingMessage,
  res: ServerResponse,
  adapterId: string,
  opts: DashboardApiOptions,
  logger: Logger,
): Promise<void> {
  const adapter = opts.adapters?.[adapterId];
  if (!adapter) {
    sendJson(res, 404, {
      error: `adapter '${adapterId}' not registered — enable it on /adapters first`,
    });
    return;
  }
  const body = (await readJsonBody(req).catch(() => ({}))) as {
    sinceIso?: string;
    limit?: number;
    dryRun?: boolean;
  };

  opts.heartbeat?.markRunBegin(adapter.id);
  const startedAt = Date.now();
  logger.info("api.adapter.sync_begin", {
    adapter: adapter.id,
    sinceIso: body.sinceIso,
    limit: body.limit,
    dryRun: body.dryRun,
  });

  try {
    const result = await runSync({
      adapter,
      engram: opts.engram,
      logger,
      ...(opts.llmRouter ? { llmRouter: opts.llmRouter } : {}),
      taxonomy: opts.taxonomy,
      opts: {
        ...(body.sinceIso ? { sinceIso: body.sinceIso } : {}),
        ...(body.limit !== undefined ? { limit: body.limit } : {}),
        ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      },
    });
    const durationMs = Date.now() - startedAt;
    opts.heartbeat?.markRunEnd(adapter.id, {
      ingested: result.ingested,
      errors: result.errors,
      durationMs,
    });
    logger.info("api.adapter.sync_done", {
      adapter: adapter.id,
      durationMs,
      ...result,
    });
    sendJson(res, 200, { ok: true, durationMs, ...result });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    opts.heartbeat?.markRunEnd(adapter.id, {
      ingested: 0,
      errors: 1,
      durationMs,
    });
    logger.error("api.adapter.sync_failed", {
      adapter: adapter.id,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      ok: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * MCP console endpoints for the dashboard's /mcp page.
 *
 *   GET  /api/mcp/tools               — catalog: name, description, jsonSchema
 *   POST /api/mcp/tools/:name/invoke  — execute a tool with JSON args,
 *                                       return the raw result + elapsed ms
 *
 * Tools run in-process against the same ToolContext the MCP server
 * uses, so behavior matches a call from Claude Code 1:1.
 */
async function handleMcpTools(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: DashboardApiOptions,
  logger: Logger,
): Promise<void> {
  try {
    if (req.method === "GET" && pathname === "/api/mcp/tools") {
      const tools = ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }),
      }));
      sendJson(res, 200, { tools });
      return;
    }

    const invokeMatch = pathname.match(/^\/api\/mcp\/tools\/([^/]+)\/invoke$/);
    if (req.method === "POST" && invokeMatch) {
      const name = decodeURIComponent(invokeMatch[1]!);
      const tool = ALL_TOOLS.find((t) => t.name === name) as
        | AnyMcpTool
        | undefined;
      if (!tool) {
        sendJson(res, 404, { error: `tool '${name}' not registered` });
        return;
      }
      if (!opts.persona) {
        sendJson(res, 503, {
          error:
            "persona client not available — tools need it in their ToolContext",
        });
        return;
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
        return;
      }

      // Resolve the *currently* active workspace's taxonomy, not the
      // one cortex booted against. Without this the console keeps
      // showing boot-time projects after the user switches workspaces
      // via the dashboard's switcher. Falls back to opts.taxonomy when
      // the cache isn't wired or no workspace is active.
      const activeWs = await getActiveWorkspace().catch(() => undefined);
      const liveTaxonomy =
        (activeWs && opts.taxonomyCache)
          ? await opts.taxonomyCache.forWorkspace(activeWs.slug)
          : opts.taxonomy;
      const ctx: ToolContext = {
        taxonomy: liveTaxonomy,
        logger: logger.child({
          component: "mcp-console",
          tool: name,
          ...(activeWs ? { workspace: activeWs.slug } : {}),
        }),
        engram: opts.engram,
        persona: opts.persona,
        ...(opts.llmRouter ? { llmRouter: opts.llmRouter } : {}),
        traceId: randomUUID(),
        sessionWorkspace: activeWs?.slug ?? null,
        ...(opts.taxonomyCache
          ? {
              invalidateTaxonomy: (slug: string) =>
                opts.taxonomyCache!.invalidate(slug),
            }
          : {}),
      };
      const startedAt = Date.now();
      try {
        const result = await tool.handler(parsed, ctx);
        sendJson(res, 200, {
          result,
          elapsedMs: Date.now() - startedAt,
          traceId: ctx.traceId,
        });
      } catch (err) {
        logger.warn("api.mcp.tool_failed", {
          tool: name,
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - startedAt,
          traceId: ctx.traceId,
        });
      }
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    logger.warn("api.mcp.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleConfig(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: DashboardApiOptions,
  logger: Logger,
): Promise<void> {
  try {
    const cfgPath = resolveConfigPath();

    if (req.method === "GET" && pathname === "/api/config") {
      const raw = await readFile(cfgPath, "utf8").catch(() => "");
      const cfg = await loadCortexConfig(cfgPath).catch(() => undefined);
      sendJson(res, 200, { path: cfgPath, raw, parsed: cfg });
      return;
    }

    if (req.method === "GET" && pathname === "/api/config/adapters") {
      const cfg = await loadCortexConfig(cfgPath);
      const adapters = listWizards()
        .filter((w) => w.category === "adapter")
        .map((w) => {
          const entry = cfg.adapters?.[w.id];
          return {
            id: w.id,
            name: w.name,
            description: w.description,
            enabled: entry?.enabled === true,
            configured: Boolean(entry),
            schedule: entry?.schedule ?? null,
          };
        });
      sendJson(res, 200, { adapters });
      return;
    }

    if (req.method === "GET" && pathname === "/api/config/providers") {
      const cfg = await loadCortexConfig(cfgPath);
      const providers = listWizards()
        .filter((w) => w.category === "provider")
        .map((w) => {
          const entry = cfg.llm?.providers?.[w.id];
          return {
            id: w.id,
            name: w.name,
            description: w.description,
            enabled: entry?.enabled === true,
            configured: Boolean(entry),
          };
        });
      sendJson(res, 200, { providers });
      return;
    }

    // /api/config/adapters/:id or /api/config/providers/:id (GET)
    const adapterGet = pathname.match(/^\/api\/config\/adapters\/([^/]+)$/);
    if (req.method === "GET" && adapterGet) {
      const id = decodeURIComponent(adapterGet[1]!);
      const cfg = await loadCortexConfig(cfgPath);
      const entry = cfg.adapters?.[id];
      sendJson(res, 200, {
        id,
        enabled: entry?.enabled === true,
        configured: Boolean(entry),
        config: entry?.config ?? {},
        schedule: entry?.schedule ?? null,
        secretsConfigured: listConfiguredSecrets(id),
      });
      return;
    }
    const providerGet = pathname.match(/^\/api\/config\/providers\/([^/]+)$/);
    if (req.method === "GET" && providerGet) {
      const id = decodeURIComponent(providerGet[1]!);
      const cfg = await loadCortexConfig(cfgPath);
      const entry = cfg.llm?.providers?.[id];
      sendJson(res, 200, {
        id,
        enabled: entry?.enabled === true,
        configured: Boolean(entry),
        config: entry?.config ?? {},
        secretsConfigured: listConfiguredSecrets(id),
      });
      return;
    }

    // Update schedule: patch an adapter's cron expression without
    // re-running the whole wizard. Empty string / null clears the
    // schedule, which means the scheduler skips it (manual-only).
    const adapterSchedule = pathname.match(
      /^\/api\/config\/adapters\/([^/]+)\/schedule$/,
    );
    if (req.method === "POST" && adapterSchedule) {
      const id = decodeURIComponent(adapterSchedule[1]!);
      const body = (await readJsonBody(req)) as { schedule?: unknown } | null;
      const raw = body?.schedule;
      const schedule =
        typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      await patchAdapterSchedule(cfgPath, id, schedule);
      const reloaded = await tryReload(opts, logger);
      logger.info("api.config.schedule", { id, schedule, reloaded });
      sendJson(res, 200, { id, schedule, reloaded });
      return;
    }

    // Toggle: flip enabled bit without re-running the wizard.
    const adapterToggle = pathname.match(
      /^\/api\/config\/adapters\/([^/]+)\/toggle$/,
    );
    if (req.method === "POST" && adapterToggle) {
      const id = decodeURIComponent(adapterToggle[1]!);
      const result = await toggleConfigEntry(cfgPath, ["adapters", id]);
      const reloaded = await tryReload(opts, logger);
      logger.info("api.config.toggle", {
        kind: "adapter",
        id,
        enabled: result.enabled,
        reloaded,
      });
      sendJson(res, 200, { ...result, reloaded });
      return;
    }
    const providerToggle = pathname.match(
      /^\/api\/config\/providers\/([^/]+)\/toggle$/,
    );
    if (req.method === "POST" && providerToggle) {
      const id = decodeURIComponent(providerToggle[1]!);
      const result = await toggleConfigEntry(cfgPath, [
        "llm",
        "providers",
        id,
      ]);
      const reloaded = await tryReload(opts, logger);
      logger.info("api.config.toggle", {
        kind: "provider",
        id,
        enabled: result.enabled,
        reloaded,
      });
      sendJson(res, 200, { ...result, reloaded });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    logger.warn("api.config.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Invoke the hot-reload hook if the server was built with one; log
 * and swallow failures so a reload error doesn't surface as a write
 * failure. Returns the ReloadResult on success, `false` when no hook
 * is wired (older builds / test harnesses), or `null` on thrown
 * errors — the write still succeeded, just the reload didn't.
 */
async function tryReload(
  opts: DashboardApiOptions,
  logger: Logger,
): Promise<ReloadResult | false | null> {
  if (!opts.reload) return false;
  try {
    return await opts.reload();
  } catch (err) {
    logger.warn("api.reload_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Report which of a wizard's declared secrets are already set in the
 * process env. Returns bare env-var names, never the values — the API
 * should never leak secret material back to the browser.
 */
function listConfiguredSecrets(wizardId: string): string[] {
  const wizard = findWizard(wizardId);
  if (!wizard) return [];
  const declared = wizard.secrets ?? [];
  return declared
    .filter((s) => {
      const v = process.env[s.envVar];
      return typeof v === "string" && v.length > 0;
    })
    .map((s) => s.envVar);
}

/**
 * Patch just the `schedule` field on an adapter entry. The scheduler
 * re-reads config at boot, so live edits only take effect on the
 * next `docker compose restart cortex` — the API returns 200 either
 * way because the write succeeded.
 *
 * Writes to the `.local.yaml` overlay when one exists — matches the
 * loader's read precedence so toggles actually take effect.
 */
async function patchAdapterSchedule(
  cfgPath: string,
  id: string,
  schedule: string | null,
): Promise<void> {
  const effectivePath = await resolveLocalFirst(cfgPath);
  const raw = await readFile(effectivePath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const adapters = parsed.adapters;
  if (!adapters || typeof adapters !== "object") {
    throw new Error("cortex.yaml has no adapters block");
  }
  const entry = (adapters as Record<string, unknown>)[id];
  if (!entry || typeof entry !== "object") {
    throw new Error(
      `adapter '${id}' isn't configured yet — run its wizard first`,
    );
  }
  const typed = entry as Record<string, unknown>;
  if (schedule === null) {
    delete typed.schedule;
  } else {
    typed.schedule = schedule;
  }
  await writeFile(effectivePath, stringifyYaml(parsed), "utf8");
}

/**
 * Flip `enabled` on an arbitrary-depth config path without re-running
 * the wizard. Only toggles if the entry already exists — callers must
 * create it first via the wizard (via POST /api/wizards/:id).
 *
 * `keyPath` walks the YAML tree (e.g. `["adapters", "github"]` or
 * `["llm", "providers", "openrouter"]`). Throws if the entry is
 * missing so the UI can surface "enable via wizard first."
 *
 * Writes to the `.local.yaml` overlay when one exists — the loader
 * reads local-first, so writing to the base file when a local overlay
 * is present would silently not take effect.
 */
async function toggleConfigEntry(
  cfgPath: string,
  keyPath: readonly string[],
): Promise<{ enabled: boolean }> {
  const effectivePath = await resolveLocalFirst(cfgPath);
  const raw = await readFile(effectivePath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  let cursor: Record<string, unknown> = parsed;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const seg = keyPath[i]!;
    const next = cursor[seg];
    if (!next || typeof next !== "object") {
      throw new Error(`config path ${keyPath.join(".")} not found`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leafKey = keyPath[keyPath.length - 1]!;
  const entry = cursor[leafKey];
  if (!entry || typeof entry !== "object") {
    throw new Error(
      `${keyPath.join(".")} isn't configured yet — run its wizard first.`,
    );
  }
  const typedEntry = entry as Record<string, unknown>;
  const nextEnabled = typedEntry.enabled !== true;
  typedEntry.enabled = nextEnabled;
  await writeFile(effectivePath, stringifyYaml(parsed), "utf8");
  return { enabled: nextEnabled };
}

/**
 * Workspace-file editors — read/write projects.yaml and people.yaml
 * via the dashboard instead of forcing the user into a text editor.
 *
 *   GET  /api/workspace-files/:name   — return raw YAML content
 *   PUT  /api/workspace-files/:name   — write back; rejects invalid YAML
 *
 * `:name` is limited to `projects` / `people` — anything else 404s
 * because we don't want the API to become a generic filesystem writer.
 */
async function handleWorkspaceFiles(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  opts: DashboardApiOptions,
  logger: Logger,
): Promise<void> {
  const allowed = new Set(["projects", "people"]);
  const match = pathname.match(/^\/api\/workspace-files\/([^/]+)$/);
  if (!match) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const name = decodeURIComponent(match[1]!);
  if (!allowed.has(name)) {
    sendJson(res, 400, {
      error: `workspace file '${name}' not editable from the dashboard`,
    });
    return;
  }

  const cfgPath = resolveConfigPath();
  const dir = path.dirname(cfgPath);
  // Resolve local-first so we read/write the overlay when present.
  // Writing to the base .yaml while the loader reads .local.yaml would
  // look like a successful save that never takes effect.
  const filePath = await resolveLocalFirst(path.join(dir, `${name}.yaml`));

  try {
    if (req.method === "GET") {
      const content = await readFile(filePath, "utf8").catch(() => "");
      sendJson(res, 200, { path: filePath, content });
      return;
    }

    if (req.method === "PUT") {
      const body = (await readJsonBody(req)) as { content?: unknown } | null;
      const content =
        body && typeof body.content === "string" ? body.content : "";
      // Parse to validate — writing invalid YAML would brick startup.
      try {
        parseYaml(content);
      } catch (err) {
        sendJson(res, 400, {
          error: `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      await writeFile(filePath, content, "utf8");
      const reloaded = await tryReload(opts, logger);
      logger.info("api.workspace_files.wrote", { name, path: filePath, reloaded });
      sendJson(res, 200, { path: filePath, bytes: content.length, reloaded });
      return;
    }

    sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    logger.warn("api.workspace_files.failed", {
      method: req.method,
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Private-module management surface used by the dashboard's Modules
 * page. Mirrors the `cortex module install / list / remove` CLI.
 *
 *   GET    /api/modules              — list registered paths + status
 *   POST   /api/modules/install      — run install; streams SSE progress
 *                                       + ends with a final event payload
 *   DELETE /api/modules/:name        — unregister (keeps files on disk)
 *
 * A restart is required for new/removed modules to take effect — the
 * loader only runs at boot. The GET response flags each entry's
 * filesystem state ("ready" / "not built" / "missing") so the UI can
 * show what the user is actually looking at.
 */
async function handleModules(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger: Logger,
): Promise<void> {
  try {
    if (req.method === "GET" && pathname === "/api/modules") {
      const repoRoot = path.dirname(path.dirname(resolveConfigPath()));
      const registered = await listPrivateModulesFromConfig({ repoRoot });
      const rows = registered.map((containerPath) => {
        const hostPath = toHostPathGuess(containerPath);
        const present = existsSync(hostPath);
        const distPresent = existsSync(
          path.join(hostPath, "dist", "index.js"),
        );
        return {
          name: path.basename(containerPath),
          containerPath,
          hostPath,
          status: !present
            ? ("missing" as const)
            : !distPresent
              ? ("not-built" as const)
              : ("ready" as const),
        };
      });
      sendJson(res, 200, { modules: rows });
      return;
    }

    if (req.method === "POST" && pathname === "/api/modules/install") {
      const body = (await readJsonBody(req)) as {
        source?: string;
        name?: string;
        noBuild?: boolean;
        pathOnly?: boolean;
        native?: boolean;
      } | null;
      if (!body?.source || typeof body.source !== "string") {
        sendJson(res, 400, { error: "body.source required" });
        return;
      }

      // Stream progress over Server-Sent Events. Dashboard shows a
      // live log while the install runs — git clone + pnpm build can
      // take a couple minutes, HTTP idle timeouts would kill a plain
      // JSON response.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const writeEvent = (
        event: string,
        data: Record<string, unknown>,
      ) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      logger.info("api.modules.install.begin", {
        source: body.source,
        name: body.name,
      });
      let closed = false;
      req.on("close", () => {
        closed = true;
      });
      const onProgress = (evt: InstallEvent) => {
        if (closed) return;
        writeEvent(evt.type, evt);
      };
      try {
        const result = await installModule({
          source: body.source,
          ...(body.name ? { name: body.name } : {}),
          ...(body.noBuild ? { noBuild: true } : {}),
          ...(body.pathOnly ? { pathOnly: true } : {}),
          ...(body.native ? { native: true } : {}),
          onProgress,
        });
        if (!closed) {
          writeEvent("done", { ...result });
          res.end();
        }
        logger.info("api.modules.install.done", {
          name: result.name,
          ok: result.ok,
        });
      } catch (err) {
        if (!closed) {
          writeEvent("error", {
            error: err instanceof Error ? err.message : String(err),
          });
          res.end();
        }
        logger.warn("api.modules.install.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    const removeMatch = pathname.match(/^\/api\/modules\/([^/]+)$/);
    if (req.method === "DELETE" && removeMatch) {
      const target = decodeURIComponent(removeMatch[1]!);
      const repoRoot = path.dirname(path.dirname(resolveConfigPath()));
      const current = await listPrivateModulesFromConfig({ repoRoot });
      const match =
        current.find((p) => p === target) ??
        current.find((p) => path.basename(p) === target);
      if (!match) {
        sendJson(res, 404, {
          error: `module '${target}' isn't registered`,
          known: current.map((p) => path.basename(p)),
        });
        return;
      }
      const { filePath, removed } = await removePrivateModule(
        { repoRoot },
        match,
      );
      logger.info("api.modules.removed", {
        target: match,
        removed,
        filePath,
      });
      sendJson(res, 200, {
        ok: removed,
        removed: match,
        configPath: filePath,
        warning:
          "Files on disk were NOT deleted. Restart cortex to pick up the removal.",
      });
      return;
    }

    sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    logger.warn("api.modules.failed", {
      method: req.method,
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort host-path reconstruction for the GET /api/modules
 * response. Mirrors the convention used by `cortex module install`:
 * modules installed under $CORTEX_HOME_HOST/modules/<name> appear
 * inside the container at /root/.cortex/modules/<name>. Anything
 * outside that root (legacy siblings, `--path-only` installs) returns
 * the container path as-is — the UI shows "host path unknown" when it
 * differs.
 */
function toHostPathGuess(containerPath: string): string {
  const normalized = containerPath.replace(/\\/g, "/");
  const cRoot = "/root/.cortex/modules";
  if (normalized.startsWith(cRoot)) {
    const rel = normalized.slice(cRoot.length).replace(/^\/+/, "");
    const hostRoot = process.env.CORTEX_HOME_HOST
      ? path.resolve(process.env.CORTEX_HOME_HOST, "modules")
      : path.resolve("./.cortex-data", "modules");
    return path.join(hostRoot, rel);
  }
  return containerPath;
}
