import type { Logger } from "@onenomad/cortex-core";
import type {
  FireArgs,
  FireResult,
  NotificationDispatcher,
} from "./dispatcher.js";
import type { TemplateName } from "./template.js";

/**
 * Notification scheduler — drives the three Prong B trigger flavors
 * on their own clocks:
 *
 *   - **morning** at 8:00 local each day
 *   - **eod** at 17:00 local each day
 *   - **pre-meeting** T-30 minutes before each calendar event,
 *     resolved by the caller-provided event source (so the scheduler
 *     stays free of calendar-API knowledge — the server wires that up).
 *
 * Independent from `packages/server/src/scheduler.ts` (which orchestrates
 * source-adapter syncs). Notification triggers don't fit the
 * "per-adapter cron + sync" shape: morning + eod fire once per day
 * and the pre-meeting trigger is dynamic per event, not periodic.
 *
 * Clock + interval timers can be injected for tests so the run path
 * is fully deterministic without real-time waits.
 */

export interface ScheduledTriggerSpec {
  flavor: "morning" | "eod";
  /** Local hour the trigger should fire each day (0-23). */
  hourLocal: number;
  /** Local minute (0-59). Defaults to 0. */
  minuteLocal?: number;
  /**
   * Caller-provided builder — called at fire time, returns the
   * FireArgs to hand to the dispatcher. Lets the server pull
   * workspace-scoped data (today-meetings, priorities, etc.) lazily
   * just before the message goes out, not at scheduler-construct time.
   */
  buildFireArgs(now: Date): Promise<FireArgs>;
}

export interface PreMeetingSpec {
  /**
   * Resolve upcoming calendar events. Called periodically by the
   * scheduler. Each event is keyed by `id` for idempotency; the
   * scheduler computes T-30 internally from `startsAt`.
   */
  fetchEvents(now: Date): Promise<UpcomingEvent[]>;
  /**
   * Caller-provided builder — produces the FireArgs for a specific
   * event. Runs at the moment the T-30 boundary is crossed.
   */
  buildFireArgs(event: UpcomingEvent, now: Date): Promise<FireArgs>;
  /** Minutes before event start to fire. Default 30. */
  leadMinutes?: number;
  /** How often to scan for new events. Default 60_000 (1 minute). */
  scanIntervalMs?: number;
}

export interface UpcomingEvent {
  /** Stable event id — used as the idempotency key suffix. */
  id: string;
  /** ISO start time. */
  startsAt: string;
  title: string;
}

export interface NotificationSchedulerOptions {
  dispatcher: NotificationDispatcher;
  logger: Logger;
  triggers?: ScheduledTriggerSpec[];
  preMeeting?: PreMeetingSpec;
  /** Inject for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Inject a custom timer factory for tests. Defaults to setTimeout
   * + clearTimeout (with `unref()` so the scheduler doesn't keep the
   * process alive on its own).
   */
  setTimer?: (cb: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NotificationScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Force a one-time scan + fire pass. Used by tests + by a future
   * `cortex notify --scan` debug subcommand.
   */
  scanOnce(now?: Date): Promise<FireResult[]>;
  size(): { triggers: number; preMeetingArmed: number };
}

interface ArmedDailyTimer {
  spec: ScheduledTriggerSpec;
  handle: unknown;
}

interface ArmedPreMeetingTimer {
  eventId: string;
  handle: unknown;
}

export function createNotificationScheduler(
  opts: NotificationSchedulerOptions,
): NotificationScheduler {
  const now = opts.now ?? (() => new Date());
  const setTimer = opts.setTimer ?? defaultSetTimer;
  const clearTimer = opts.clearTimer ?? defaultClearTimer;
  const triggers = opts.triggers ?? [];
  const preMeeting = opts.preMeeting;

  const dailyArmed: ArmedDailyTimer[] = [];
  const preMeetingArmed = new Map<string, ArmedPreMeetingTimer>();
  let scanTimer: unknown | undefined;
  let started = false;

  const armDailyNext = (spec: ScheduledTriggerSpec): ArmedDailyTimer => {
    const fireAt = nextLocalDailyFire(now(), spec.hourLocal, spec.minuteLocal ?? 0);
    const delay = Math.max(0, fireAt.getTime() - now().getTime());
    opts.logger.debug("notification.scheduler.next_daily", {
      flavor: spec.flavor,
      at: fireAt.toISOString(),
      delayMs: delay,
    });
    const handle = setTimer(async () => {
      const fireNow = now();
      try {
        const args = await spec.buildFireArgs(fireNow);
        const result = await opts.dispatcher.fire(args);
        opts.logger.info("notification.scheduler.daily_fired", {
          flavor: spec.flavor,
          status: result.status,
        });
      } catch (err) {
        opts.logger.error("notification.scheduler.daily_failed", {
          flavor: spec.flavor,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (started) {
          // Re-arm for the next day.
          const next = armDailyNext(spec);
          const idx = dailyArmed.findIndex((d) => d.spec === spec);
          if (idx >= 0) dailyArmed[idx] = next;
        }
      }
    }, delay);
    return { spec, handle };
  };

  const armPreMeeting = (event: UpcomingEvent): void => {
    if (!preMeeting) return;
    const lead = (preMeeting.leadMinutes ?? 30) * 60_000;
    const fireAt = new Date(new Date(event.startsAt).getTime() - lead);
    const delay = fireAt.getTime() - now().getTime();
    if (delay <= -60_000) return; // already past the window
    if (preMeetingArmed.has(event.id)) return; // already scheduled

    const handle = setTimer(async () => {
      try {
        const args = await preMeeting.buildFireArgs(event, now());
        const result = await opts.dispatcher.fire(args);
        opts.logger.info("notification.scheduler.pre_meeting_fired", {
          eventId: event.id,
          status: result.status,
        });
      } catch (err) {
        opts.logger.error("notification.scheduler.pre_meeting_failed", {
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        preMeetingArmed.delete(event.id);
      }
    }, Math.max(0, delay));

    preMeetingArmed.set(event.id, { eventId: event.id, handle });
  };

  const scanForEvents = async (): Promise<void> => {
    if (!preMeeting) return;
    let events: UpcomingEvent[];
    try {
      events = await preMeeting.fetchEvents(now());
    } catch (err) {
      opts.logger.warn("notification.scheduler.scan_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const event of events) armPreMeeting(event);
  };

  const armScanLoop = (): void => {
    if (!preMeeting) return;
    const interval = preMeeting.scanIntervalMs ?? 60_000;
    const tick = async (): Promise<void> => {
      await scanForEvents();
      if (started) scanTimer = setTimer(() => { void tick(); }, interval);
    };
    // Kick off the first scan immediately so events that exist right
    // at startup get picked up before the first interval elapses.
    scanTimer = setTimer(() => { void tick(); }, 0);
  };

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      for (const t of triggers) dailyArmed.push(armDailyNext(t));
      armScanLoop();
      opts.logger.info("notification.scheduler.started", {
        triggers: triggers.length,
        preMeetingEnabled: !!preMeeting,
      });
    },

    async stop(): Promise<void> {
      started = false;
      for (const armed of dailyArmed) clearTimer(armed.handle);
      dailyArmed.length = 0;
      for (const armed of preMeetingArmed.values()) clearTimer(armed.handle);
      preMeetingArmed.clear();
      if (scanTimer !== undefined) {
        clearTimer(scanTimer);
        scanTimer = undefined;
      }
      opts.logger.info("notification.scheduler.stopped");
    },

    async scanOnce(_at?: Date): Promise<FireResult[]> {
      // Manual fire-now path: walks all current events + arms each
      // pre-meeting timer, then immediately invokes any daily trigger
      // whose fire time has passed. Returns the results so callers
      // (e.g. a future `cortex notify --catchup` debug command) can
      // surface them.
      const out: FireResult[] = [];
      const fireNow = now();
      for (const t of triggers) {
        const localHour = fireNow.getHours();
        const localMin = fireNow.getMinutes();
        const target = t.hourLocal * 60 + (t.minuteLocal ?? 0);
        const current = localHour * 60 + localMin;
        if (current >= target) {
          try {
            const args = await t.buildFireArgs(fireNow);
            out.push(await opts.dispatcher.fire(args));
          } catch (err) {
            opts.logger.error("notification.scheduler.scan_once_daily_failed", {
              flavor: t.flavor,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      if (preMeeting) await scanForEvents();
      return out;
    },

    size(): { triggers: number; preMeetingArmed: number } {
      return {
        triggers: dailyArmed.length,
        preMeetingArmed: preMeetingArmed.size,
      };
    },
  };
}

/**
 * Next datetime ≥ `from` whose local hour:minute equals (h, m). If
 * today's slot has already passed, picks tomorrow's slot.
 */
export function nextLocalDailyFire(from: Date, h: number, m: number): Date {
  const candidate = new Date(from);
  candidate.setHours(h, m, 0, 0);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function defaultSetTimer(cb: () => void, delayMs: number): unknown {
  const handle = setTimeout(cb, delayMs);
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  if (handle && typeof handle === "object") {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

export type { TemplateName };
