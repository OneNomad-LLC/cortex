import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Logger } from "@onenomad/przm-cortex-core";

export interface AdapterRunStats {
  /** Cron expression this adapter is scheduled on. */
  schedule?: string;
  /** ISO 8601 of the last successful run. */
  lastRunAt?: string;
  /** Duration of the last run in ms. */
  lastRunMs?: number;
  /** Items ingested on the last run. */
  lastRunIngested?: number;
  /** Total runs in this process lifetime. */
  runs: number;
  /** Runs that raised. */
  errors: number;
  /** True when the adapter is actively running. */
  running: boolean;
}

export interface Heartbeat {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  uptimeMs: number;
  mcp: { connected: boolean; transport: string };
  /** Health of the in-process memory backend. Cortex 0.3+ no longer
   *  spawns Engram or Persona MCP subprocesses; the field is retained
   *  in its narrower shape so heartbeat consumers (CLI `cortex status`,
   *  the dashboard) can probe memory health without breaking. */
  upstream: { engram: boolean };
  adapters: Record<string, AdapterRunStats>;
}

export interface HeartbeatWriterOptions {
  intervalMs?: number;
  filePath?: string;
  logger: Logger;
}

/**
 * Location of the heartbeat file. Override via `PRZM_CORTEX_HEARTBEAT_PATH`
 * so operators can point multiple hosts at a shared volume.
 */
export function defaultHeartbeatPath(): string {
  return (
    process.env.PRZM_CORTEX_HEARTBEAT_PATH ??
    path.join(os.homedir(), ".cortex", "heartbeat.json")
  );
}

/**
 * In-memory state + periodic JSON writer. Scheduler + upstream clients
 * mutate this; a timer flushes to disk every `intervalMs` so `cortex
 * status` has a fresh picture without each update doing IO.
 */
export class HeartbeatWriter {
  private readonly state: Heartbeat;
  private readonly intervalMs: number;
  private readonly filePath: string;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | undefined;
  private readonly startedAtMs: number;

  constructor(opts: HeartbeatWriterOptions) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.filePath = opts.filePath ?? defaultHeartbeatPath();
    this.logger = opts.logger;
    this.startedAtMs = Date.now();
    this.state = {
      pid: process.pid,
      startedAt: new Date(this.startedAtMs).toISOString(),
      lastHeartbeatAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs: 0,
      mcp: { connected: false, transport: "stdio" },
      upstream: { engram: false },
      adapters: {},
    };
  }

  async start(): Promise<void> {
    await this.flush();
    this.timer = setInterval(() => {
      void this.flush().catch((err) => {
        this.logger.warn("heartbeat.flush_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Remove the heartbeat file — `cortex status` treats its absence as
    // "no daemon running".
    await unlink(this.filePath).catch(() => undefined);
  }

  setMcpConnected(connected: boolean, transport = "stdio"): void {
    this.state.mcp = { connected, transport };
  }

  setUpstream(engram: boolean): void {
    this.state.upstream = { engram };
  }

  /** Register an adapter with its schedule. Called at startup. */
  registerAdapter(id: string, schedule: string | undefined): void {
    const existing = this.state.adapters[id];
    this.state.adapters[id] = {
      ...(existing ?? { runs: 0, errors: 0, running: false }),
      ...(schedule ? { schedule } : {}),
    };
  }

  markRunBegin(id: string): void {
    const entry = this.state.adapters[id] ?? {
      runs: 0,
      errors: 0,
      running: true,
    };
    entry.running = true;
    this.state.adapters[id] = entry;
  }

  markRunEnd(
    id: string,
    result: { ingested: number; errors: number; durationMs: number },
  ): void {
    const entry = this.state.adapters[id] ?? {
      runs: 0,
      errors: 0,
      running: false,
    };
    entry.runs += 1;
    entry.errors += result.errors;
    entry.lastRunAt = new Date().toISOString();
    entry.lastRunMs = result.durationMs;
    entry.lastRunIngested = result.ingested;
    entry.running = false;
    this.state.adapters[id] = entry;
  }

  /**
   * Per-item update from a long-running stream worker or webhook receiver.
   * Each event folds into the shared adapter counters so `cortex status`
   * shows a unified picture — you can't tell from the report whether a
   * number came from a cron run, a file save, or an inbound webhook.
   */
  markStreamItem(
    id: string,
    result: { ingested: number; errors: number },
  ): void {
    const entry = this.state.adapters[id] ?? {
      runs: 0,
      errors: 0,
      running: false,
    };
    entry.runs += 1;
    entry.errors += result.errors;
    entry.lastRunAt = new Date().toISOString();
    entry.lastRunIngested = result.ingested;
    this.state.adapters[id] = entry;
  }

  /** Snapshot for in-process inspection (tests). */
  snapshot(): Heartbeat {
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.state.uptimeMs = Date.now() - this.startedAtMs;
    return structuredClone(this.state);
  }

  private async flush(): Promise<void> {
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.state.uptimeMs = Date.now() - this.startedAtMs;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(this.state, null, 2)}\n`,
      "utf8",
    );
  }
}

/**
 * Read the heartbeat file. Returns `null` when it doesn't exist — the
 * `cortex status` command treats that as "no daemon running".
 */
export async function readHeartbeat(
  filePath: string = defaultHeartbeatPath(),
): Promise<Heartbeat | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Heartbeat;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
