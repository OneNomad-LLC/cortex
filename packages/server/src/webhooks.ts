import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  Logger,
  SourceAdapter,
  WebhookHandler,
  WebhookRequest,
} from "@cortex/core";
import type { LLMRouter } from "@cortex/llm-core";
import type { EngramClient } from "./clients/engram.js";
import type { HeartbeatWriter } from "./heartbeat.js";
import {
  buildPipelineContext,
  processItem,
  resolvePipelines,
} from "./sync.js";

export interface WebhookReceiverOptions {
  adapters: readonly SourceAdapter[];
  engram: EngramClient;
  llmRouter?: LLMRouter;
  heartbeat?: HeartbeatWriter;
  logger: Logger;
  host?: string;
  port: number;
}

export interface WebhookReceiver {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolved to the actual bound port (handy when `port: 0` was requested). */
  boundPort(): number | undefined;
  /** Routes registered at boot. Useful for diagnostics. */
  routes(): ReadonlyArray<{ adapter: string; path: string; methods: readonly string[] }>;
}

interface Route {
  adapter: SourceAdapter;
  handler: WebhookHandler;
  methods: readonly string[];
}

/**
 * Tiny HTTP server that serves as the inbound endpoint for push-based
 * sources. Built on `node:http` rather than Express/Fastify because:
 *  - The surface is small (a switch statement on `path + method`).
 *  - We need raw request bodies for HMAC verification; most frameworks
 *    make that harder, not easier.
 *  - Adding a dep to the server package is a bigger commitment than a
 *    handful of vanilla http lines.
 *
 * The receiver never sends back error details — a failed signature gets
 * a plain 401 so a probing attacker doesn't learn which header field was
 * the problem. Successful parses respond 204 regardless of how many items
 * were produced, so providers stop retrying.
 */
export function createWebhookReceiver(
  opts: WebhookReceiverOptions,
): WebhookReceiver {
  const routes: Route[] = [];
  for (const adapter of opts.adapters) {
    if (typeof adapter.webhook !== "function") continue;
    const webhookCtx = {
      logger: opts.logger.child({ adapter: adapter.id, via: "webhook" }),
    };
    const handlers = adapter.webhook(webhookCtx);
    const list = Array.isArray(handlers) ? handlers : [handlers];
    for (const h of list) {
      if (!h.path.startsWith("/")) {
        throw new Error(
          `webhook: adapter '${adapter.id}' returned path '${h.path}' (must start with '/')`,
        );
      }
      routes.push({
        adapter,
        handler: h,
        methods: h.methods && h.methods.length > 0 ? h.methods : ["POST"],
      });
    }
  }

  // Pre-compute pipelines per adapter so a webhook under load isn't
  // rebuilding the pipeline list on every request.
  const pipelinesByAdapter = new Map(
    routes.map((r) => [r.adapter.id, resolvePipelines(r.adapter)] as const),
  );

  let server: Server | undefined;
  let bound: number | undefined;

  const onRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const route = routes.find(
      (r) => r.handler.path === req.url && r.methods.includes(req.method ?? "GET"),
    );
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }

    let rawBody = "";
    try {
      rawBody = await readBody(req);
    } catch (err) {
      opts.logger.warn("webhook.read_failed", {
        adapter: route.adapter.id,
        error: err instanceof Error ? err.message : String(err),
      });
      res.statusCode = 400;
      res.end();
      return;
    }

    const hookReq: WebhookRequest = {
      method: req.method ?? "POST",
      path: req.url ?? route.handler.path,
      headers: normalizeHeaders(req.headers),
      rawBody,
    };

    const verifyResult = await route.handler.verify(hookReq);
    if (!verifyResult.ok) {
      opts.logger.warn("webhook.rejected", {
        adapter: route.adapter.id,
        path: route.handler.path,
        reason: verifyResult.reason,
      });
      res.statusCode = 401;
      res.end();
      return;
    }

    let items;
    try {
      items = await route.handler.parse(hookReq);
    } catch (err) {
      opts.logger.warn("webhook.parse_failed", {
        adapter: route.adapter.id,
        error: err instanceof Error ? err.message : String(err),
      });
      res.statusCode = 400;
      res.end();
      return;
    }

    // Respond fast — the provider is waiting. Process items asynchronously
    // so slow pipelines don't extend the request lifetime and risk a
    // retry storm from the sender.
    res.statusCode = 204;
    res.end();

    if (items.length === 0) {
      opts.logger.debug("webhook.no_items", {
        adapter: route.adapter.id,
      });
      return;
    }

    const traceId = randomUUID();
    const itemLogger = opts.logger.child({
      adapter: route.adapter.id,
      via: "webhook",
      traceId,
    });
    const pipelineCtx = buildPipelineContext({
      logger: itemLogger,
      traceId,
      signal: new AbortController().signal,
      ...(opts.llmRouter ? { llmRouter: opts.llmRouter } : {}),
    });
    const pipelines = pipelinesByAdapter.get(route.adapter.id) ?? [];

    for (const raw of items) {
      const per = await processItem({
        adapter: route.adapter,
        raw,
        pipelines,
        pipelineCtx,
        engram: opts.engram,
        logger: itemLogger,
      });
      if (opts.heartbeat) {
        opts.heartbeat.registerAdapter(route.adapter.id, undefined);
        opts.heartbeat.markStreamItem(route.adapter.id, {
          ingested: per.ingested,
          errors: per.error ? 1 : 0,
        });
      }
    }
  };

  return {
    async start() {
      if (routes.length === 0) {
        opts.logger.info("webhook.receiver.no_routes");
        return;
      }
      server = createServer((req, res) => {
        void onRequest(req, res).catch((err) => {
          opts.logger.warn("webhook.handler_unhandled", {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(opts.port, opts.host ?? "0.0.0.0", () => {
          const addr = server!.address();
          if (addr && typeof addr === "object") bound = addr.port;
          resolve();
        });
      });
      opts.logger.info("webhook.receiver.started", {
        port: bound,
        routeCount: routes.length,
      });
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    },
    boundPort: () => bound,
    routes: () =>
      routes.map((r) => ({
        adapter: r.adapter.id,
        path: r.handler.path,
        methods: r.methods,
      })),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
  }
  return out;
}
