import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { Logger } from "@cortex/core";
import { ALL_WIDGETS, WIDGETS_BY_NAME } from "./widgets/index.js";
import type { Widget, WidgetContext } from "./types.js";

export interface DashboardApiOptions extends WidgetContext {
  host?: string;
  port: number;
  logger: Logger;
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
        "/api/widgets",
        ...ALL_WIDGETS.map((w) => `/api/widgets/${w.name}`),
      ];
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("vary", "origin");
}
