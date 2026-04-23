import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { Logger } from "@cortex/core";
import type { DeviceCodeGrant } from "@cortex/github-auth";
import {
  createDeviceFlow,
  defaultTokenPath as defaultGithubTokenPath,
  tryReadGithubToken,
  writeGithubToken,
} from "@cortex/github-auth";
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
} from "../cli/workspace/manager.js";
import { readState } from "../cli/workspace/state.js";
import { loadCortexConfig } from "../config.js";
import {
  type DashboardLayout,
  loadDashboardLayout,
  resolveLayout,
} from "./layout.js";
import { ALL_WIDGETS, WIDGETS_BY_NAME } from "./widgets/index.js";
import type { Widget, WidgetContext } from "./types.js";

export interface DashboardApiOptions extends WidgetContext {
  host?: string;
  port: number;
  logger: Logger;
  /**
   * Path to the `dashboard.yaml` template. Re-read on every `/api/layout`
   * request so users can edit and refresh without bouncing the server.
   * If omitted, `/api/layout` returns the built-in delivery preset.
   */
  layoutPath?: string;
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
    llmRouter: opts.llmRouter,
    taxonomy: opts.taxonomy,
  };

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
      sendJson(res, 200, { ok: true, version: 1, widgets: ALL_WIDGETS.length });
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
        widgets: ALL_WIDGETS.map((w) => ({
          name: w.name,
          description: w.description,
        })),
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/widgets/")) {
      const name = pathname.slice("/api/widgets/".length);
      const widget: Widget | undefined = WIDGETS_BY_NAME.get(name);
      if (!widget) {
        sendJson(res, 404, { error: `widget '${name}' not found` });
        return;
      }
      const started = Date.now();
      try {
        const payload = await widget.handler(url.searchParams, {
          ...widgetCtx,
          logger: logger.child({ widget: name }),
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
      await handleWizards(req, res, logger);
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
            widgets: ALL_WIDGETS.length,
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
        ...ALL_WIDGETS.map((w) => `/api/widgets/${w.name}`),
        "GET /api/workspaces",
        "POST /api/workspaces",
        "POST /api/workspaces/switch",
        "DELETE /api/workspaces/:slug",
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
  // Dashboard dev server runs on :3000 by default; allow any localhost origin
  // so alternate Next.js ports work without reconfig. Production should run
  // dashboard and API on the same host behind a proxy — origin match isn't
  // the security boundary here, the localhost bind is.
  const allow =
    origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ? origin
      : "*";
  res.setHeader("access-control-allow-origin", allow);
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, DELETE, OPTIONS",
  );
  res.setHeader("access-control-allow-headers", "content-type");
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
      sendJson(res, 200, {
        applied: true,
        filesWritten: applied.filesWritten,
        restartRequired: true,
        warning:
          "Config written. Restart `cortex start` (or the sidecar) so the new settings take effect.",
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
