import test from "node:test";
import assert from "node:assert/strict";

import {
  createNotificationScheduler,
  nextLocalDailyFire,
} from "../dist/scheduler.js";

function nullLogger() {
  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
}

function spyDispatcher() {
  const fired = [];
  return {
    fired,
    async fire(args) {
      fired.push(args);
      return {
        status: "sent",
        triggerId: args.triggerId,
        firedAt: new Date(0).toISOString(),
        message: "ok",
      };
    },
  };
}

/**
 * Manual timer harness — replaces setTimeout/clearTimeout. Tests pump
 * scheduled callbacks by calling `tick(delayMs)` to simulate time
 * advancing; callbacks whose deadlines fall in the elapsed window
 * fire in chronological order.
 */
function manualClock(initialIso) {
  let now = new Date(initialIso);
  const queue = [];
  let nextHandleId = 1;
  return {
    nowFn: () => new Date(now),
    setTimer(cb, delayMs) {
      const id = nextHandleId++;
      queue.push({ id, fireAt: now.getTime() + delayMs, cb, cancelled: false });
      queue.sort((a, b) => a.fireAt - b.fireAt);
      return id;
    },
    clearTimer(handle) {
      const entry = queue.find((q) => q.id === handle);
      if (entry) entry.cancelled = true;
    },
    async tick(deltaMs) {
      const target = now.getTime() + deltaMs;
      // Drain in chronological order; callbacks may schedule new
      // timers within the same window, so loop until quiescent.
      while (true) {
        const next = queue.find((q) => !q.cancelled && q.fireAt <= target);
        if (!next) break;
        next.cancelled = true;
        now = new Date(next.fireAt);
        await next.cb();
      }
      now = new Date(target);
    },
    advance(toIso) {
      const target = new Date(toIso);
      const delta = target.getTime() - now.getTime();
      return this.tick(delta);
    },
    pendingCount() {
      return queue.filter((q) => !q.cancelled).length;
    },
  };
}

test("nextLocalDailyFire: today's slot still pending → today", () => {
  const from = new Date("2026-04-27T05:00:00.000");  // 5am local
  const fire = nextLocalDailyFire(from, 8, 0);
  assert.equal(fire.getHours(), 8);
  assert.equal(fire.getMinutes(), 0);
  assert.equal(fire.getDate(), 27);
});

test("nextLocalDailyFire: today's slot already past → tomorrow", () => {
  const from = new Date("2026-04-27T09:00:00.000");  // 9am local, past 8am
  const fire = nextLocalDailyFire(from, 8, 0);
  assert.equal(fire.getHours(), 8);
  assert.equal(fire.getDate(), 28);
});

test("nextLocalDailyFire: exactly at the slot → tomorrow (strictly after)", () => {
  const from = new Date("2026-04-27T08:00:00.000");
  const fire = nextLocalDailyFire(from, 8, 0);
  // Equal-time gets bumped to tomorrow so we don't double-fire.
  assert.equal(fire.getDate(), 28);
});

test("scheduler: morning trigger fires at the local hour", async () => {
  // Start at 7:55 local; morning fires at 8:00. Advance 5 minutes.
  const clock = manualClock("2026-04-27T07:55:00.000");
  const dispatcher = spyDispatcher();
  const scheduler = createNotificationScheduler({
    dispatcher,
    logger: nullLogger(),
    triggers: [
      {
        flavor: "morning",
        hourLocal: 8,
        minuteLocal: 0,
        async buildFireArgs(now) {
          return {
            flavor: "morning",
            triggerId: `morning-brief:${now.toISOString().slice(0, 10)}`,
            template: "morning-brief",
            vars: { date: now.toISOString().slice(0, 10) },
          };
        },
      },
    ],
    now: clock.nowFn,
    setTimer: clock.setTimer.bind(clock),
    clearTimer: clock.clearTimer.bind(clock),
  });
  await scheduler.start();
  await clock.tick(5 * 60_000); // advance to 8:00
  assert.equal(dispatcher.fired.length, 1);
  assert.equal(dispatcher.fired[0].flavor, "morning");
  await scheduler.stop();
});

test("scheduler: morning trigger re-arms for the next day after firing", async () => {
  const clock = manualClock("2026-04-27T07:59:00.000");
  const dispatcher = spyDispatcher();
  const scheduler = createNotificationScheduler({
    dispatcher,
    logger: nullLogger(),
    triggers: [
      {
        flavor: "morning",
        hourLocal: 8,
        async buildFireArgs(now) {
          return {
            flavor: "morning",
            triggerId: `morning-brief:${now.toISOString().slice(0, 10)}`,
            template: "morning-brief",
            vars: {},
          };
        },
      },
    ],
    now: clock.nowFn,
    setTimer: clock.setTimer.bind(clock),
    clearTimer: clock.clearTimer.bind(clock),
  });
  await scheduler.start();
  await clock.tick(60_000); // 8:00 → first fire
  assert.equal(dispatcher.fired.length, 1);
  // Advance 24h → second fire at 8:00 the next day
  await clock.tick(24 * 60 * 60_000);
  assert.equal(dispatcher.fired.length, 2);
  await scheduler.stop();
});

test("scheduler: pre-meeting fires T-30 before event", async () => {
  // Now=10:00. Event at 11:00 → T-30 at 10:30.
  const clock = manualClock("2026-04-27T10:00:00.000Z");
  const dispatcher = spyDispatcher();
  let calls = 0;
  const scheduler = createNotificationScheduler({
    dispatcher,
    logger: nullLogger(),
    preMeeting: {
      async fetchEvents() {
        calls++;
        return [
          { id: "evt-A", title: "Standup", startsAt: "2026-04-27T11:00:00.000Z" },
        ];
      },
      async buildFireArgs(event) {
        return {
          flavor: "pre-meeting",
          triggerId: `pre-meeting:${event.id}`,
          template: "pre-meeting-brief",
          vars: { event_title: event.title, minutes_until: 30 },
        };
      },
      leadMinutes: 30,
      scanIntervalMs: 60_000,
    },
    now: clock.nowFn,
    setTimer: clock.setTimer.bind(clock),
    clearTimer: clock.clearTimer.bind(clock),
  });
  await scheduler.start();
  // Advance 30 min → should hit 10:30 → T-30 fires
  await clock.tick(30 * 60_000);
  assert.ok(dispatcher.fired.length >= 1);
  const fired = dispatcher.fired.find((f) => f.flavor === "pre-meeting");
  assert.ok(fired);
  assert.equal(fired.triggerId, "pre-meeting:evt-A");
  assert.ok(calls >= 1, "fetchEvents was called");
  await scheduler.stop();
});

test("scheduler: pre-meeting idempotent — same event seen twice in scans only fires once", async () => {
  const clock = manualClock("2026-04-27T10:00:00.000Z");
  const dispatcher = spyDispatcher();
  const scheduler = createNotificationScheduler({
    dispatcher,
    logger: nullLogger(),
    preMeeting: {
      async fetchEvents() {
        // Returns the same event on every scan.
        return [
          { id: "evt-B", title: "Recurring", startsAt: "2026-04-27T11:00:00.000Z" },
        ];
      },
      async buildFireArgs(event) {
        return {
          flavor: "pre-meeting",
          triggerId: `pre-meeting:${event.id}`,
          template: "pre-meeting-brief",
          vars: {},
        };
      },
      leadMinutes: 30,
      scanIntervalMs: 60_000,
    },
    now: clock.nowFn,
    setTimer: clock.setTimer.bind(clock),
    clearTimer: clock.clearTimer.bind(clock),
  });
  await scheduler.start();
  await clock.tick(30 * 60_000); // hits 10:30 → fires once
  // 10 more minutes — scan re-runs but the event is past its T-30 + already armed/fired
  await clock.tick(10 * 60_000);
  const preMeetingFires = dispatcher.fired.filter((f) => f.flavor === "pre-meeting");
  assert.equal(preMeetingFires.length, 1, "T-30 fires exactly once per event");
  await scheduler.stop();
});

test("scheduler: stop() clears all pending timers", async () => {
  const clock = manualClock("2026-04-27T08:00:00.000");
  const scheduler = createNotificationScheduler({
    dispatcher: spyDispatcher(),
    logger: nullLogger(),
    triggers: [
      {
        flavor: "morning",
        hourLocal: 8,
        async buildFireArgs() {
          return {
            flavor: "morning",
            triggerId: "x",
            template: "morning-brief",
            vars: {},
          };
        },
      },
    ],
    preMeeting: {
      async fetchEvents() {
        return [];
      },
      async buildFireArgs() {
        return {
          flavor: "pre-meeting",
          triggerId: "y",
          template: "pre-meeting-brief",
          vars: {},
        };
      },
      scanIntervalMs: 30_000,
    },
    now: clock.nowFn,
    setTimer: clock.setTimer.bind(clock),
    clearTimer: clock.clearTimer.bind(clock),
  });
  await scheduler.start();
  assert.ok(clock.pendingCount() > 0);
  await scheduler.stop();
  assert.equal(clock.pendingCount(), 0, "stop() cancels all queued timers");
});
