/**
 * `/api/dashboard/logs` — read-only log view tuned for the Dashboard
 * Logs page. Wraps the same ring-buffer + on-disk source the MCP
 * `recent_logs` tool reads, but with the surface a browser polls every
 * few seconds:
 *
 *   - Server-side `since` filter so the client only ships the new tail
 *     between polls (no client-side dedupe needed).
 *   - Server-side `level` + `adapter` filters so the wire payload
 *     stays small even when the runtime log is noisy.
 *   - Default limit 200, hard cap 2000.
 *
 * Auth: scoped to `read`. Bearer or `cortex_dash_sid` cookie both work
 * via the standard `requireDashboardAuth` gate.
 */

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http.js";
import type { RouteContext } from "../route-context.js";
import { requireDashboardAuth } from "../middleware/require-dashboard-auth.js";
import { getSharedLogBus, type LogLine } from "../../log-bus.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
type Level = "debug" | "info" | "warn" | "error";

function resolveRuntimeLogPath(): string {
  const home = process.env.PRZM_CORTEX_HOME ?? path.join(os.homedir(), ".cortex");
  return path.join(home, "logs", "runtime.log");
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  if (ctx.pathname !== "/api/dashboard/logs") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const gate = requireDashboardAuth(["read"]);
  const session = await gate(req, res);
  if (!session) return true;

  const { searchParams } = ctx.url;
  const since = searchParams.get("since") ?? undefined;
  const level = (searchParams.get("level") ?? undefined) as Level | undefined;
  const adapter = searchParams.get("adapter") ?? undefined;
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw
    ? Math.max(1, Math.min(MAX_LIMIT, Number(limitRaw)))
    : DEFAULT_LIMIT;

  const lines = await readLines();
  let filtered = lines;
  if (since) filtered = filtered.filter((l) => l.ts > since);
  if (level) filtered = filtered.filter((l) => l.level === level);
  if (adapter) {
    filtered = filtered.filter((l) => {
      const candidate =
        (l as { adapter?: unknown }).adapter ??
        (l as { component?: unknown }).component;
      return typeof candidate === "string" && candidate === adapter;
    });
  }

  const matched = filtered.length;
  const out =
    filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;

  sendJson(res, 200, {
    lines: out,
    matched,
    limit,
    workspace: session.session.workspace,
  });
  return true;
}

/**
 * Combined ring + disk fetch shared with the MCP `recent_logs` tool —
 * keeps the two surfaces in sync without circular-importing the tool
 * module. The disk read tails the last 128KB so a multi-day-old log
 * file doesn't get loaded whole; the dashboard's typical use is the
 * recent tail anyway.
 */
async function readLines(): Promise<LogLine[]> {
  const bus = getSharedLogBus();
  const ringLines = bus.recent(2000);

  const diskLines: LogLine[] = [];
  const sourcePath = resolveRuntimeLogPath();
  if (existsSync(sourcePath)) {
    try {
      const buf = await readFile(sourcePath, "utf8");
      const tail = buf.length > 131072 ? buf.slice(buf.length - 131072) : buf;
      for (const raw of tail.split("\n")) {
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as LogLine;
          if (parsed && typeof parsed.ts === "string") diskLines.push(parsed);
        } catch {
          // Slice-truncated first line — skip.
        }
      }
    } catch {
      // Disk failure isn't fatal; ring buffer still serves.
    }
  }

  const combined = new Map<string, LogLine>();
  for (const line of [...diskLines, ...ringLines]) {
    const key = `${line.ts}|${line.level}|${line.msg}`;
    combined.set(key, line);
  }
  return Array.from(combined.values()).sort((a, b) =>
    a.ts.localeCompare(b.ts),
  );
}
