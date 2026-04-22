import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadCortexConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { buildLLMRouter } from "../registry/providers.js";
import { buildAdapterRegistry } from "../registry/adapters.js";
import { createScheduler } from "../scheduler.js";
import { createEngramClient } from "../clients/engram.js";
import { createPersonaClient } from "../clients/persona.js";
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
  const configPath =
    process.env.CORTEX_CONFIG_PATH ??
    path.resolve(process.cwd(), "config/cortex.yaml");

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

  // Engram and Persona are stdio MCP subprocesses. Spawn once at startup
  // and reuse for every tool call. Failures to spawn are fatal for now —
  // every Cortex tool past list_projects needs at least Engram.
  const engram = await createEngramClient({ logger });
  const engramHealth = await engram.healthCheck();
  logger.info("engram.ready", { healthy: engramHealth.healthy });

  const persona = await createPersonaClient({ logger });
  const personaHealth = await persona.healthCheck();
  logger.info("persona.ready", { healthy: personaHealth.healthy });

  const scheduler = createScheduler({
    engram,
    llmRouter: router,
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
    try {
      const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(parsed, toolContext);
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

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info("mcp.connected", { transport: "stdio" });

  const shutdown = async (): Promise<void> => {
    logger.info("shutdown.begin");
    await scheduler.stop();
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
