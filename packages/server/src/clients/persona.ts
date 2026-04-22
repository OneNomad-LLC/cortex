import type { HealthStatus, Logger } from "@cortex/core";
import {
  callJsonTool,
  connectMcpSubprocess,
  type McpSubprocess,
} from "./mcp-subprocess.js";

export interface PersonaClientOptions {
  /** Bin name for the Persona MCP server. Default: "persona-mcp". */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  logger: Logger;
}

export type CognitiveLoad = "low" | "medium" | "high";

export interface PersonaClient {
  /** Current cognitive load from Persona's brain state. */
  cognitiveLoad(): Promise<CognitiveLoad>;
  /** Record a user-reaction signal for Persona to learn from. */
  signal(event: {
    type: string;
    content: string;
    context?: string;
    category?: string;
  }): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
}

/**
 * Real Persona client. Spawns `persona-mcp` as a stdio subprocess and
 * wraps the tools Cortex uses. Persona's full tool surface is broader
 * (analyze, evolve, synthesize, etc.) — wrap more as features need them.
 */
export async function createPersonaClient(
  opts: PersonaClientOptions,
): Promise<PersonaClient> {
  const sub = await connectMcpSubprocess({
    id: "persona",
    command: opts.command ?? "persona-mcp",
    args: opts.args ?? [],
    ...(opts.env ? { env: opts.env } : {}),
    logger: opts.logger,
  });
  return buildClient(sub, opts.logger);
}

function buildClient(sub: McpSubprocess, logger: Logger): PersonaClient {
  let lastSuccessAt: number | undefined;

  return {
    async cognitiveLoad() {
      const ctx = await callJsonTool<Record<string, unknown>>(
        sub.client,
        "persona_context",
        {},
      );
      lastSuccessAt = Date.now();
      const load = coerceLoad(ctx);
      return load;
    },

    async signal(event) {
      await callJsonTool(sub.client, "persona_signal", {
        type: event.type,
        content: event.content,
        ...(event.context ? { context: event.context } : {}),
        ...(event.category ? { category: event.category } : {}),
      });
      lastSuccessAt = Date.now();
    },

    async healthCheck(): Promise<HealthStatus> {
      try {
        const state = await callJsonTool<Record<string, unknown>>(
          sub.client,
          "persona_state",
          {},
        );
        lastSuccessAt = Date.now();
        return {
          healthy: true,
          message: "",
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
          details: state ?? {},
        };
      } catch (err) {
        logger.warn("persona.healthcheck.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        };
      }
    },

    async shutdown() {
      await sub.close();
    },
  };
}

/**
 * Persona's context response structure evolves as Persona evolves. Accept
 * several shapes (cognitiveLoad as number or label, direct or nested
 * under brainState) and degrade to "medium" when we can't tell.
 */
function coerceLoad(ctx: Record<string, unknown> | undefined): CognitiveLoad {
  if (!ctx) return "medium";
  const direct = ctx.cognitiveLoad ?? ctx.cognitive_load;
  const nested = (ctx.brainState as Record<string, unknown> | undefined)?.cognitiveLoad;
  const value = direct ?? nested;

  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "low" || v === "medium" || v === "high") return v;
  }
  if (typeof value === "number") {
    if (value < 0.34) return "low";
    if (value > 0.66) return "high";
    return "medium";
  }
  return "medium";
}
