import type { EngramAccess, HealthStatus, Logger } from "@onenomad/cortex-core";
import {
  callJsonTool,
  connectMcpSubprocess,
  type McpSubprocess,
} from "./mcp-subprocess.js";
import { resolvePackageBin } from "./resolve-bin.js";

export interface EngramClientOptions {
  /** Bin name for the Engram MCP server. Default: "engram-memory". */
  command?: string;
  args?: string[];
  /** Extra env passed to the subprocess (e.g. ENGRAM_DATA_DIR overrides). */
  env?: Record<string, string>;
  logger: Logger;
}

export interface EngramSearchArgs {
  query: string;
  /** Cap on returned memories. */
  limit?: number;
  /** Project slug filter. Matches the `project` tag in memory metadata. */
  project?: string;
  /** Content-type filter (meeting, decision, doc, etc.). */
  type?: string;
  /** Source filter (loom, confluence, ...). */
  source?: string;
  /** ISO 8601 lower bound on the `date` field. */
  sinceIso?: string;
  /** Domain to search within. Cortex uses "work". */
  domain?: string;
}

export interface EngramMemory {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  type?: string;
}

export interface EngramClient extends EngramAccess {
  search(args: EngramSearchArgs): Promise<EngramMemory[]>;
  shutdown(): Promise<void>;
}

/**
 * Real Engram client: spawns `engram-memory` as a stdio MCP subprocess and
 * wraps a handful of tools we care about.
 *
 * The Engram MCP server advertises ~20 tools; we wrap only what Cortex
 * currently uses and add more as tools are plumbed into Cortex features.
 */
export async function createEngramClient(
  opts: EngramClientOptions,
): Promise<EngramClient> {
  const resolved = opts.command
    ? undefined
    : resolvePackageBin("@onenomad/engram-memory");
  const spawnOpts = resolved
    ? {
        command: resolved.node,
        args: [resolved.script, ...(opts.args ?? [])],
      }
    : {
        command: opts.command ?? "engram-memory",
        args: opts.args ?? [],
      };
  const sub = await connectMcpSubprocess({
    id: "engram",
    ...spawnOpts,
    ...(opts.env ? { env: opts.env } : {}),
    logger: opts.logger,
  });

  return buildClient(sub, opts.logger);
}

function buildClient(sub: McpSubprocess, logger: Logger): EngramClient {
  let lastSuccessAt: number | undefined;

  return {
    async ingest(input) {
      const res = await callJsonTool<{ id?: string } | string>(
        sub.client,
        "memory_ingest",
        {
          content: input.content,
          metadata: input.metadata,
        },
      );
      lastSuccessAt = Date.now();
      const id =
        typeof res === "object" && res && "id" in res
          ? (res as { id: string }).id
          : "";
      return { id };
    },

    async search(args) {
      const payload: Record<string, unknown> = {
        query: args.query,
        limit: args.limit ?? 10,
        domain: args.domain ?? "work",
      };
      const filters: Record<string, unknown> = {};
      if (args.project) filters.project = args.project;
      if (args.type) filters.type = args.type;
      if (args.source) filters.source = args.source;
      if (args.sinceIso) filters.since = args.sinceIso;
      if (Object.keys(filters).length > 0) payload.filters = filters;

      const res = await callJsonTool<{
        memories?: EngramMemory[];
      } | EngramMemory[]>(sub.client, "memory_search", payload);
      lastSuccessAt = Date.now();

      if (Array.isArray(res)) return res;
      return res?.memories ?? [];
    },

    async healthCheck(): Promise<HealthStatus> {
      try {
        const stats = await callJsonTool<Record<string, unknown>>(
          sub.client,
          "memory_stats",
          {},
        );
        lastSuccessAt = Date.now();
        return {
          healthy: true,
          message: "",
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
          details: stats ?? {},
        };
      } catch (err) {
        logger.warn("engram.healthcheck.failed", {
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
