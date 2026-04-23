import type { Logger, SourceAdapter } from "@onenomad/cortex-core";
import type { LLMRouter } from "@onenomad/cortex-llm-core";
import type { EngramClient } from "./clients/engram.js";
import { parseCron, nextFireAfter, type CronSchedule } from "./cron.js";
import type { HeartbeatWriter } from "./heartbeat.js";
import { runSync } from "./sync.js";

export interface SchedulerOptions {
  engram: EngramClient;
  llmRouter: LLMRouter;
  logger: Logger;
  /**
   * Optional — when set, sync calls pass this as `since`. In v1 we
   * don't persist per-adapter cursors yet, so every scheduler-driven
   * run is either a full sweep (bounded by the adapter's own
   * maxItemsPerRun) or `since = lastRunAt` (kept in memory only).
   */
  rememberLastRun?: boolean;
  /**
   * Optional — when provided, the scheduler reports per-run stats to
   * the heartbeat writer. `cortex status` reads the resulting file.
   */
  heartbeat?: HeartbeatWriter;
}

export interface Scheduler {
  register(adapter: SourceAdapter, cronExpr: string | undefined): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Number of currently-registered adapter entries. */
  size(): number;
}

interface Entry {
  adapter: SourceAdapter;
  schedule: CronSchedule;
  timer: NodeJS.Timeout | undefined;
  running: boolean;
  lastRunAt: Date | undefined;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const entries = new Map<string, Entry>();
  let started = false;

  const scheduleNext = (entry: Entry): void => {
    const now = new Date();
    const next = nextFireAfter(entry.schedule, now);
    const delay = Math.max(0, next.getTime() - now.getTime());
    opts.logger.debug("scheduler.next", {
      adapter: entry.adapter.id,
      at: next.toISOString(),
      delayMs: delay,
    });
    entry.timer = setTimeout(() => {
      void fire(entry);
    }, delay);
    // Don't keep the process alive just for the scheduler — if nothing
    // else is pending (e.g. stdio MCP closed) we want to exit cleanly.
    entry.timer.unref?.();
  };

  const fire = async (entry: Entry): Promise<void> => {
    if (entry.running) {
      opts.logger.warn("scheduler.overlap_skipped", {
        adapter: entry.adapter.id,
        reason: "previous run still in progress",
      });
      scheduleNext(entry);
      return;
    }

    entry.running = true;
    opts.heartbeat?.markRunBegin(entry.adapter.id);
    const start = Date.now();
    const sinceIso = opts.rememberLastRun && entry.lastRunAt
      ? entry.lastRunAt.toISOString()
      : undefined;

    opts.logger.info("scheduler.run_begin", {
      adapter: entry.adapter.id,
      sinceIso,
    });

    let ingested = 0;
    let errCount = 0;
    try {
      const result = await runSync({
        adapter: entry.adapter,
        engram: opts.engram,
        logger: opts.logger,
        llmRouter: opts.llmRouter,
        opts: {
          ...(sinceIso ? { sinceIso } : {}),
        },
      });
      ingested = result.ingested;
      errCount = result.errors;
      entry.lastRunAt = new Date(start);
      opts.logger.info("scheduler.run_done", {
        adapter: entry.adapter.id,
        durationMs: Date.now() - start,
        ...result,
      });
    } catch (err) {
      errCount = 1;
      opts.logger.error("scheduler.run_failed", {
        adapter: entry.adapter.id,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      entry.running = false;
      opts.heartbeat?.markRunEnd(entry.adapter.id, {
        ingested,
        errors: errCount,
        durationMs: Date.now() - start,
      });
      if (started) scheduleNext(entry);
    }
  };

  return {
    register(adapter, cronExpr) {
      if (!cronExpr || cronExpr.trim().length === 0) {
        opts.logger.info("scheduler.skip_no_schedule", { adapter: adapter.id });
        opts.heartbeat?.registerAdapter(adapter.id, undefined);
        return;
      }
      try {
        const schedule = parseCron(cronExpr);
        entries.set(adapter.id, {
          adapter,
          schedule,
          timer: undefined,
          running: false,
          lastRunAt: undefined,
        });
        opts.heartbeat?.registerAdapter(adapter.id, cronExpr);
        opts.logger.info("scheduler.registered", {
          adapter: adapter.id,
          schedule: cronExpr,
        });
      } catch (err) {
        opts.logger.warn("scheduler.bad_schedule", {
          adapter: adapter.id,
          schedule: cronExpr,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async start() {
      started = true;
      for (const entry of entries.values()) {
        scheduleNext(entry);
      }
      opts.logger.info("scheduler.started", { adapters: entries.size });
    },

    async stop() {
      started = false;
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      opts.logger.info("scheduler.stopped");
    },

    size() {
      return entries.size;
    },
  };
}
