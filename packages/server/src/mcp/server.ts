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
import { hotReload, type LiveState } from "../hot-reload.js";
import { createMemoryClient } from "../clients/memory.js";
import { createPersonaClient } from "../clients/persona.js";
import { startStreamWorkers } from "../streams.js";
import { createWebhookReceiver } from "../webhooks.js";
import { createDashboardApi } from "../api/server.js";
import { startDashboardChild } from "../dashboard-child.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadTaxonomy } from "../taxonomy.js";
import { ALL_TOOLS } from "./tools/index.js";
import { CORTEX_MCP_INSTRUCTIONS } from "./instructions.js";
import type { AnyMcpTool, ToolContext } from "./tool.js";
import { loadPrivateModules } from "../private-modules.js";
import { resolveSessionWorkspaceSlug } from "../session-workspace-helpers.js";
import { TaxonomyCache } from "../taxonomy-cache.js";
import {
  evictStaleSessions,
  restoreSessionStates,
  sessionCount,
} from "../session-context.js";

/**
 * Register the shared ListTools + CallTool handlers on a Server
 * instance. Extracted as a helper so the HTTP transport can create
 * a fresh Server per MCP session while reusing the same closures
 * (tool registry, taxonomy cache, engram client, persona client).
 */
function wireTools(args: {
  mcp: Server;
  allTools: AnyMcpTool[];
  toolContext: ToolContext;
  logger: ReturnType<typeof createLogger>;
  taxonomyCache: TaxonomyCache;
}): void {
  const { mcp, allTools, toolContext, logger, taxonomyCache } = args;
  const toolsByName = new Map<string, AnyMcpTool>();
  for (const tool of allTools) toolsByName.set(tool.name, tool);

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
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
    // Resolve the session's workspace binding here (once per call)
    // so tools don't have to each re-import the session helpers.
    // Null means explicit no-workspace; undefined means unbound.
    const sessionWorkspace = await resolveSessionWorkspaceSlug();
    // Load per-session taxonomy (cached by workspace slug). Falls
    // back to the bootstrap taxonomy for no-workspace mode so tools
    // like `list_projects` still return *something* rather than an
    // empty list that reads like a config error.
    const callTaxonomy = sessionWorkspace
      ? await taxonomyCache.forWorkspace(sessionWorkspace)
      : toolContext.taxonomy;
    const callContext: ToolContext = {
      ...toolContext,
      taxonomy: callTaxonomy,
      logger: callLogger,
      traceId,
      sessionWorkspace: sessionWorkspace ?? null,
      invalidateTaxonomy: (slug) => taxonomyCache.invalidate(slug),
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
}

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

  // Rehydrate session→workspace bindings from the last run. Dropping
  // sessions older than 24h keeps the file bounded; anything active
  // in the last day keeps its binding across server restarts.
  const restored = await restoreSessionStates().catch(() => 0);
  if (restored > 0) {
    logger.info("sessions.restored", { count: restored });
  }

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
    taxonomy,
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
  // Mutable container so a hot reload can swap references to the
  // adapter registry, scheduler entries, LLM router, and taxonomy
  // without every consumer having to refetch.
  const liveState: LiveState = {
    configPath,
    repoRoot,
    logger,
    engram,
    heartbeat,
    adapters: adapterRegistry.adapters,
    adapterRegistry,
    router: { current: router },
    taxonomy: { current: taxonomy },
    scheduler,
  };
  const triggerReload = (): Promise<ReturnType<typeof hotReload> extends Promise<infer R> ? R : never> =>
    hotReload(liveState);

  // Per-workspace taxonomy cache. Created here (before the dashboard
  // API) so both the MCP tool-call pipeline and the dashboard's MCP
  // console can share the same cache — otherwise the console keeps
  // handing out the boot-time workspace's projects long after the
  // user switched.
  const taxonomyCache = new TaxonomyCache(
    logger.child({ component: "taxonomy-cache" }),
  );

  const dashboardApi = cfg.api.enabled
    ? createDashboardApi({
        engram,
        llmRouter: router,
        taxonomy,
        heartbeat,
        persona,
        adapters: liveState.adapters,
        reload: triggerReload,
        taxonomyCache,
        logger: logger.child({ component: "dashboard-api" }),
        host: cfg.api.host,
        port: cfg.api.port,
        layoutPath: path.join(repoRoot, "config", "dashboard.yaml"),
      })
    : undefined;
  if (dashboardApi) {
    await dashboardApi.start();
  }

  // Dashboard UI auto-start — spawn the Next.js dev server as a child
  // when we're running as a daemon (HTTP MCP). When Cortex is spawned
  // by Claude Code as a stdio subprocess, skip it: spawning Next
  // inside Claude's process tree would be intrusive and noisy.
  // In Docker, the dashboard runs as its own container, so the server
  // sets CORTEX_DASHBOARD_AUTOSTART=false to opt out of the child.
  const autoStartDashboard =
    cfg.api.enabled &&
    (process.env.CORTEX_MCP_TRANSPORT ?? "stdio") === "http" &&
    process.env.CORTEX_DASHBOARD_AUTOSTART !== "false";
  const dashboardChild = autoStartDashboard
    ? await startDashboardChild({
        logger: logger.child({ component: "dashboard-child" }),
        apiHost: cfg.api.host,
        apiPort: cfg.api.port,
      }).catch((err) => {
        logger.warn("dashboard.start_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      })
    : undefined;

  // Session garbage collection. In-memory session state is cheap but
  // not free — evict anything we haven't seen in 24h. Runs hourly.
  const SESSION_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
  const sessionGcTimer = setInterval(() => {
    const removed = evictStaleSessions(SESSION_MAX_IDLE_MS);
    if (removed > 0) {
      logger.info("session_gc.evicted", {
        removed,
        remaining: sessionCount(),
      });
    }
  }, 60 * 60 * 1000);
  sessionGcTimer.unref?.();

  const toolContext: ToolContext = {
    taxonomy,
    logger,
    engram,
    persona,
    llmRouter: router,
  };

  // Load private modules (job profile, personal playbooks, etc.) —
  // these are packages living outside the public Cortex repo whose
  // tools merge into the MCP surface just like built-ins. Paths
  // come from the privateModules config list.
  const privateModules = await loadPrivateModules(
    cfg.privateModules,
    logger.child({ component: "private-modules" }),
  );
  const privateTools: AnyMcpTool[] = privateModules.flatMap((m) => m.tools);
  const allTools: AnyMcpTool[] = [...ALL_TOOLS, ...privateTools];

  // Factory used by the HTTP transport to spin up a fresh Server per
  // MCP session. The SDK's Server marks itself `_initialized` on the
  // first `initialize` call — a second client hitting the same Server
  // is rejected with "Server already initialized," which made concurrent
  // Claude clients impossible under the old "one Server per process"
  // shape. One Server per session fixes it; the shared tool context +
  // taxonomy cache + engram/persona clients flow through the closure.
  const buildMcp = (): Server => {
    const mcp = new Server(
      { name: "cortex", version: "0.0.0" },
      {
        capabilities: { tools: {} },
        instructions: CORTEX_MCP_INSTRUCTIONS,
      },
    );
    wireTools({
      mcp,
      allTools,
      toolContext,
      logger,
      taxonomyCache,
    });
    return mcp;
  };

  const transportHandle = await connectConfiguredTransport({
    buildMcp,
    logger,
  });
  heartbeat.setMcpConnected(true, transportHandle.kind);

  const shutdown = async (): Promise<void> => {
    logger.info("shutdown.begin");
    clearInterval(sessionGcTimer);
    await scheduler.stop();
    await Promise.all(streamWorkers.map((w) => w.stop()));
    if (webhookReceiver) await webhookReceiver.stop();
    if (dashboardChild) await dashboardChild.stop();
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

  // Block until a shutdown signal arrives. Without this gate the whole
  // function returns right after setup, runCli resolves, and the
  // entrypoint's `process.exit(code)` tears everything down — HTTP
  // listeners included. That manifested as "sidecar dies a moment
  // after api.listening" in the detached init flow.
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      void shutdown().finally(resolve);
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    // Windows console close (Ctrl+Break, terminal close) delivers
    // SIGBREAK, not SIGINT. Handle it the same way so detached
    // processes don't get orphaned after a clean console close.
    process.once("SIGBREAK", finish);
  });
}
