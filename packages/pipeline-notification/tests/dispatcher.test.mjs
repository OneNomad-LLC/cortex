import test from "node:test";
import assert from "node:assert/strict";

import { createNotificationDispatcher } from "../dist/dispatcher.js";

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

function memoryIdempotency() {
  const fired = new Map();
  return {
    hasFired(id) {
      return fired.get(id) ?? null;
    },
    recordFire(id, firedAt) {
      // INSERT OR IGNORE semantics — first write wins.
      if (!fired.has(id)) fired.set(id, firedAt);
    },
    close() {},
    _all: fired,
  };
}

function spyTransport(opts = {}) {
  const sent = [];
  return {
    sent,
    async send(args) {
      sent.push(args);
      if (opts.fail) return { ok: false, detail: opts.detail ?? "boom" };
      if (opts.throw) throw new Error(opts.detail ?? "thrown");
      return { ok: true };
    },
  };
}

const FIXED_NOW = new Date("2026-04-27T12:00:00.000Z");

function freshDispatcher(extras = {}) {
  const transport = extras.transport ?? spyTransport();
  const idempotency = extras.idempotency ?? memoryIdempotency();
  const dispatcher = createNotificationDispatcher({
    transport,
    idempotency,
    logger: nullLogger(),
    channel: "@self",
    now: () => FIXED_NOW,
  });
  return { dispatcher, transport, idempotency };
}

test("dispatcher: fire renders + sends + records when idempotency clean", async () => {
  const { dispatcher, transport, idempotency } = freshDispatcher();
  const result = await dispatcher.fire({
    flavor: "morning",
    triggerId: "morning-brief:2026-04-27",
    template: "morning-brief",
    vars: { date: "2026-04-27", meetings: false, priorities: false, overnight: false, dashboard_url: "x" },
  });
  assert.equal(result.status, "sent");
  assert.equal(result.firedAt, FIXED_NOW.toISOString());
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].channel, "@self");
  assert.match(transport.sent[0].message, /Morning brief/);
  assert.equal(idempotency.hasFired("morning-brief:2026-04-27"), FIXED_NOW.toISOString());
});

test("dispatcher: second fire with same triggerId is skipped_duplicate", async () => {
  const { dispatcher, transport, idempotency } = freshDispatcher();
  await dispatcher.fire({
    flavor: "morning",
    triggerId: "dup-test",
    template: "morning-brief",
    vars: {},
  });
  const second = await dispatcher.fire({
    flavor: "morning",
    triggerId: "dup-test",
    template: "morning-brief",
    vars: {},
  });
  assert.equal(second.status, "skipped_duplicate");
  // Transport called once (the original send), not twice.
  assert.equal(transport.sent.length, 1);
  // Idempotency keeps the original fire time.
  assert.equal(idempotency.hasFired("dup-test"), FIXED_NOW.toISOString());
});

test("dispatcher: dry_run logs but does NOT send or record", async () => {
  const { dispatcher, transport, idempotency } = freshDispatcher();
  const result = await dispatcher.fire({
    flavor: "eod",
    triggerId: "eod:2026-04-27",
    template: "eod-capture",
    vars: { date: "2026-04-27", touched_count: 5, open_count: 2, resolved_count: 3, plural_touched: "s", open_list: "- a", dashboard_url: "x" },
    dryRun: true,
  });
  assert.equal(result.status, "dry_run");
  assert.match(result.message, /End of day/);
  assert.equal(transport.sent.length, 0);
  assert.equal(idempotency.hasFired("eod:2026-04-27"), null);
});

test("dispatcher: transport rejection → transport_failed, no idempotency record", async () => {
  const transport = spyTransport({ fail: true, detail: "channel_not_found" });
  const idempotency = memoryIdempotency();
  const { dispatcher } = freshDispatcher({ transport, idempotency });
  const result = await dispatcher.fire({
    flavor: "morning",
    triggerId: "morning-brief:2026-04-27",
    template: "morning-brief",
    vars: {},
  });
  assert.equal(result.status, "transport_failed");
  assert.equal(result.detail, "channel_not_found");
  // No idempotency record — operator can retry.
  assert.equal(idempotency.hasFired("morning-brief:2026-04-27"), null);
});

test("dispatcher: transport throws → transport_failed, no idempotency record", async () => {
  const transport = spyTransport({ throw: true, detail: "ECONNRESET" });
  const idempotency = memoryIdempotency();
  const { dispatcher } = freshDispatcher({ transport, idempotency });
  const result = await dispatcher.fire({
    flavor: "morning",
    triggerId: "thrown-test",
    template: "morning-brief",
    vars: {},
  });
  assert.equal(result.status, "transport_failed");
  assert.match(result.detail ?? "", /ECONNRESET/);
  assert.equal(idempotency.hasFired("thrown-test"), null);
});
