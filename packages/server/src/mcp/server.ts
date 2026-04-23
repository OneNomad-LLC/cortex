import path from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectConfiguredTransport } from "./transport.js";
import { resolveConfigPath } from "../cli/config-path.js";
import { loadCortexConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { buildLLMRouter } from "../registry/providers.js";
import { buildAdapterRegistry } from "../registry/adapters.js";
import { createScheduler } from "../scheduler.js";
import { HeartbeatWriter } from "../heartbeat.js";
import { createMemoryClient } from "../clients/memory.js";
import { createPersonaClient } from "../clients/persona.js";
import { startStreamWorkers } from "../streams.js";
import { createWebhookReceiver } from "../webhooks.js";
import { createDashboardApi } from "../api/server.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadTaxonomy } from "../taxonomy.js";
import { ALL_TOOLS } from "./tools/index.js";
import type { AnyMcpTool, ToolContext } from "./tool.js";

/**
 * Boots the Cortex MCP server. Loads config + taxonomy, stands up the LLM
 * router, spawns Engram and Persona as MCP subprocesses, and starts the
 * stdio MCP server advertising Cortex's tools.
 */
export async function startServer(): Promise<void> {
  const logger = createLogger({ component: "cortex-server" });
  const configPath = resolveConfigPath();

  logger.info("startup.begin", { configPath });
  const cfg = await loadCortexConfig(configPath);

  const repoRoot = path.resolve(path.dirname(configPath), "..");
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(repoRoot, "config", "projects.yaml"),
    peoplePath: path.join(repoRoot, "config", "people.yaml"),
  });
  logger.info("taxonomy.ready", {
    projects: taxonomy.projects.length,
    people: taxonomy.people.length,
  });

  const { router, providers } = await buildLLMRouter({
    cfg,
    env: process.env,
    logger,
  });
  logger.info("llm.router.ready", {
    providerCount: Object.keys(providers).length,
    taskCount: Object.keys(cfg.llm.tasks).length,
  });

  // Memory backend — engram (primary) or pgvector (local Postgres fallback).
  // The factory handles health checks and falls back to the configured
  // secondary if the primary is unreachable at boot. Past this point the
  // rest of the server only sees an EngramClient shape; whether it's
  // backed by the MCP subprocess or a SQL store is opaque to the tools.
  const memoryBoot = await createMemoryClient({
    memory: cfg.memory,
    llmRouter: router,
    logger,
  });
  const engram = memoryBoot.client;
  const engramHealth = await engram.healthCheck();
  logger.info("memory.ready", {
    selected: memoryBoot.selected,
    primaryHealthy: memoryBoot.primaryHealthy,
    healthy: engramHealth.healthy,
  });

  const persona = await createPersonaClient({ logger });
  const personaHealth = await persona.healthCheck();
  logger.info("persona.ready", { healthy: personaHealth.healthy });

  const heartbeat = new HeartbeatWriter({ logger });
  heartbeat.setUpstream(engramHealth.healthy, personaHealth.healthy);
  await heartbeat.start();

  const scheduler = createScheduler({
    engram,
    llmRouter: router,
    heartbeat,
    logger,
  });

  // Adapter registry — pulls enabled adapters from cortex.yaml and runs
  // their init. Scheduler registers each one with its cron schedule and
  // starts firing after the whole server is up.
  const adapterRegistry = await buildAdapterRegistry({
    cfg,
    env: process.env,
    logger,
    buildContext: (adapterId, entryConfig, secrets) => ({
      logger: logger.child({ adapter: adapterId }),
      config: entryConfig,
      secrets,
      signal: new AbortController().signal,
      engram: {
        ingest: (input) => engram.ingest(input),
        healthCheck: () => engram.healthCheck(),
      },
      taxonomy,
      llm: {
        raw: router,
        complete: async ({ task, prompt, system, maxTokens, temperature, signal }) => {
          const res = await router.complete({
            task,
            messages: [
              ...(system ? [{ role: "system" as const, content: system }] : []),
              { role: "user" as const, content: prompt },
            ],
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(signal ? { signal } : {}),
          });
          return res.content;
        },
      },
    }),
  });
  logger.info("adapters.ready", { count: Object.keys(adapterRegistry.adapters).length });

  // Register every enabled adapter with the scheduler using its own cron
  // expression from cortex.yaml. Adapters without a schedule (e.g. ad-hoc
  // Obsidian) just skip — they remain reachable via `cortex sync`.
  for (const [id, adapter] of Object.entries(adapterRegistry.adapters)) {
    const entry = cfg.adapters[id];
    scheduler.register(adapter, entry?.schedule);
  }
  await scheduler.start();

  // Any adapter that implements stream() gets a long-running worker — the
  // file-watcher path for Obsidian, the events-WS path for Slack, etc.
  // These run alongside cron, not in place of it, because dropped events
  // are common and a periodic walk catches what the stream missed.
  const streamWorkers = startStreamWorkers({
    adapters: Object.values(adapterRegistry.adapters),
    engram,
    llmRouter: router,
    heartbeat,
    logger,
  });
  if (streamWorkers.length > 0) {
    logger.info("streams.started", {
      count: streamWorkers.length,
      adapters: streamWorkers.map((w) => w.adapterId),
    });
  }

  // Webhook receiver — only boots if enabled in cortex.yaml AND at least
  // one adapter implements webhook(). Providers deliver to the configured
  // port; operators expose it publicly via Tailscale Funnel, a reverse
  // proxy, or ngrok depending on deployment shape.
  const webhookReceiver = cfg.webhooks.enabled
    ? createWebhookReceiver({
        adapters: Object.values(adapterRegistry.adapters),
        engram,
        llmRouter: router,
        heartbeat,
        logger,
        host: cfg.webhooks.host,
        port: cfg.webhooks.port,
      })
    : undefined;
  if (webhookReceiver) {
    await webhookReceiver.start();
  }

  // Dashboard API sidecar — ADR-015. Off by default; the dashboard is a
  // per-user local app, so most operators flip api.enabled=true only when
  // they run the dashboard next to cortex start.
  const dashboardApi = cfg.api.enabled
    ? createDashboardApi({
        engram,
        llmRouter: router,
        taxonomy,
        logger: logger.child({ component: "dashboard-api" }),
        host: cfg.api.host,
        port: cfg.api.port,
        layoutPath: path.join(repoRoot, "config", "dashboard.yaml"),
      })
    : undefined;
  if (dashboardApi) {
    await dashboardApi.start();
  }

  const mcp = new Server(
    { name: "cortex", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  const toolContext: ToolContext = {
    taxonomy,
    logger,
    engram,
    persona,
    llmRouter: router,
  };
  const toolsByName = new Map<string, AnyMcpTool>();
  for (const tool of ALL_TOOLS) toolsByName.set(tool.name, tool);

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Tool '${req.params.name}' not found.` },
        ],
        isError: true,
      };
    }
    // One trace id per call. Logger bound so every log line on this
    // invocation carries it; any memory written during the call gets
    // it stamped on metadata.
    const traceId = randomUUID();
    const callLogger = logger.child({ traceId, tool: tool.name });
    const callContext: ToolContext = {
      ...toolContext,
      logger: callLogger,
      traceId,
    };
    const started = Date.now();
    callLogger.info("tool.call.begin");
    try {
      const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(parsed, callContext);
      callLogger.info("tool.call.done", { ms: Date.now() - started });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      logger.warn("tool.failed", {
        tool: tool.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  });

  const transportHandle = await connectConfiguredTransport({ mcp, logger });
  heartbeat.setMcpConnected(true, transportHandle.kind);

  const shutdown = async (): Promise<void> => {
    logger.info("shutdown.begin");
    await scheduler.stop();
    await Promise.all(streamWorkers.map((w) => w.stop()));
    if (webhookReceiver) await webhookReceiver.stop();
    if (dashboardApi) await dashboardApi.stop();
    try {
      await transportHandle.close();
    } catch (err) {
      logger.warn("mcp.transport.close_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await heartbeat.stop();
    for (const provider of Object.values(providers)) {
      try {
        await provider.shutdown();
      } catch (err) {
        logger.warn("provider.shutdown.error", {
          id: provider.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      await engram.shutdown();
    } catch (err) {
      logger.warn("engram.shutdown.error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await persona.shutdown();
    } catch (err) {
      logger.warn("persona.shutdown.error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await adapterRegistry.shutdown();
    } catch (err) {
      logger.warn("adapters.shutdown.error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info("shutdown.done");
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}
