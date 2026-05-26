import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import { getSharedLogBus, type LogLine } from "../../log-bus.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * Max lines to return. Defaults to 100; capped at 2000 so a runaway
   * caller can't pull the entire log file into a single MCP response.
   */
  limit: z.number().int().min(1).max(2000).default(100),
  /**
   * ISO timestamp filter — only return lines with `ts >= since`.
   * Used by Pyre's Activity tab to poll incrementally without
   * re-fetching the full tail every refresh.
   */
  since: z.string().optional(),
  /**
   * Optional level filter ('debug' | 'info' | 'warn' | 'error').
   * Server-side filter so callers don't have to ship the noise back.
   */
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
});

interface Output {
  /** Lines matching the filter, oldest → newest. Already capped. */
  lines: LogLine[];
  /** Total before applying limit, for "X / Y total" indicators. */
  matched: number;
  /** Truthful path so the caller can surface "Logs at: ..." for ops. */
  source: string;
}

/**
 * Read recent runtime log lines. Combines two sources:
 *   1. The in-memory ring buffer (last ~500 lines, lost on restart).
 *   2. The on-disk runtime.log file (persists across restarts —
 *      written by createLogger's appendToDisk path).
 *
 * Why both: the ring is fast + always fresh, but resets every time
 * Cortex MCP is killed (every Pyre restart, every dev iteration). The
 * disk file survives but has a small write-buffer latency. Reading
 * both + de-duping by ts+msg gets the best of both — historical
 * context AND current liveness.
 *
 * Pyre's Activity sub-tab polls this every few seconds with `since`
 * = the last seen ts; lines persist across Pyre sessions because the
 * disk file does.
 */
function resolveRuntimeLogPath(): string {
  const home = process.env.PRZM_CORTEX_HOME ?? path.join(os.homedir(), ".cortex");
  return path.join(home, "logs", "runtime.log");
}

export const recentLogsTool: McpTool<typeof inputSchema, Output> = {
  name: "recent_logs",
  description:
    "Read recent runtime log lines from this Cortex install. Combines " +
    "the in-memory ring buffer (live) with the on-disk runtime.log " +
    "(persistent across restarts). Returns oldest→newest lines, " +
    "filtered by `since` + `level`. Use for live-tailing from a " +
    "client UI (Pyre's Cortex page Activity tab uses this) or for " +
    "ad-hoc 'what just happened' lookups.",
  inputSchema,

  async handler({ limit, since, level }) {
    const sourcePath = resolveRuntimeLogPath();
    const bus = getSharedLogBus();
    const ringLines = bus.recent(limit * 2); // generous; we'll dedupe + cap below

    // Disk read. Tail the last 64KB of the file to bound memory; full
    // file scans would hurt on long-running installs. JSON-line per
    // log line so partial first-line corruption from the slice is
    // skipped (parse failure → drop).
    const diskLines: LogLine[] = [];
    if (existsSync(sourcePath)) {
      try {
        const buf = await readFile(sourcePath, "utf8");
        // Take the last ~64KB worth — enough for thousands of typical lines
        // without loading multi-MB log files.
        const tail = buf.length > 65536 ? buf.slice(buf.length - 65536) : buf;
        for (const raw of tail.split("\n")) {
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as LogLine;
            if (parsed && typeof parsed.ts === "string") diskLines.push(parsed);
          } catch {
            // Truncated first line from the slice — skip.
          }
        }
      } catch {
        // Disk read failure isn't fatal; ring buffer still serves.
      }
    }

    // Combine ring + disk, dedupe on ts+msg+level (ring entries appear
    // in both since they're appended to disk). Sort ascending by ts so
    // callers can append the latest tail without resorting client-side.
    const combined = new Map<string, LogLine>();
    for (const line of [...diskLines, ...ringLines]) {
      const key = `${line.ts}|${line.level}|${line.msg}`;
      combined.set(key, line);
    }
    let merged = Array.from(combined.values()).sort((a, b) =>
      a.ts.localeCompare(b.ts),
    );

    // Apply `since` filter — ts strings are ISO so lexicographic
    // compare matches chronological compare.
    if (since) merged = merged.filter((l) => l.ts > since);
    if (level) merged = merged.filter((l) => l.level === level);

    const matched = merged.length;
    // Cap to limit, keeping the NEWEST. The caller wants recent activity.
    const lines = merged.length > limit ? merged.slice(merged.length - limit) : merged;

    return { lines, matched, source: sourcePath };
  },
};
