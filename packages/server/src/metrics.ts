/**
 * Prometheus metrics for Cortex MCP server (ADR-022 / Task #13).
 *
 * Three histograms are exposed:
 *   - cortex_mcp_tool_duration_seconds  — per-tool call latency (labeled by
 *     `tool` and `status`). This is the primary SLA signal: p95 must stay
 *     under the threshold in legal/sla-template.md.
 *   - cortex_search_duration_seconds    — semantic memory search latency.
 *   - cortex_ingest_duration_seconds    — memory write latency.
 *
 * All metrics are registered on a dedicated Registry (not prom-client's
 * default), so the /metrics route controls exactly what is exported and
 * other libraries that happen to touch the default registry don't pollute
 * the scrape.
 *
 * Node.js runtime metrics (heap, CPU, event-loop lag) are collected on the
 * same registry via `collectDefaultMetrics` — useful for correlating latency
 * spikes with GC pressure or CPU saturation.
 */

import { Registry, Histogram, collectDefaultMetrics } from "prom-client";
import type { EngramClient } from "./clients/engram.js";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

/**
 * All MCP tool call durations, labeled by tool name and completion status.
 * Buckets include 0.1 s and 0.2 s boundaries to make the 200 ms p95 target
 * visible in Grafana / Prometheus queries without interpolation.
 */
export const mcpToolDuration = new Histogram({
  name: "cortex_mcp_tool_duration_seconds",
  help: "Duration of MCP tool calls in seconds. SLA target: p95 ≤ 0.2 s.",
  labelNames: ["tool", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/** Latency of engram.search() — the semantic memory search path. */
export const searchDuration = new Histogram({
  name: "cortex_search_duration_seconds",
  help: "Duration of semantic search (engram.search) calls in seconds.",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});

/** Latency of engram.ingest() — the memory write path. */
export const ingestDuration = new Histogram({
  name: "cortex_ingest_duration_seconds",
  help: "Duration of memory ingest (engram.ingest) calls in seconds.",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Returns a thin observability wrapper around `client` that records search
 * and ingest durations on the cortex histograms. All other methods are
 * forwarded unchanged; callers see no difference.
 */
export function wrapEngramWithMetrics(client: EngramClient): EngramClient {
  return {
    async ingest(input) {
      const start = Date.now();
      try {
        return await client.ingest(input);
      } finally {
        ingestDuration.observe((Date.now() - start) / 1000);
      }
    },
    async search(args) {
      const start = Date.now();
      try {
        return await client.search(args);
      } finally {
        searchDuration.observe((Date.now() - start) / 1000);
      }
    },
    healthCheck: () => client.healthCheck(),
    ...(client.delete !== undefined
      ? { delete: (input) => client.delete!(input) }
      : {}),
    shutdown: () => client.shutdown(),
    wipeAll: () => client.wipeAll(),
    exportAll: (opts) => client.exportAll(opts),
    ...(client.dumpDataDir !== undefined
      ? { dumpDataDir: () => client.dumpDataDir!() }
      : {}),
  };
}
