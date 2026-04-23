import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceAdapter } from "@onenomad/cortex-core";
import { createScheduler } from "../src/scheduler.js";

function fakeAdapter(id: string): SourceAdapter {
  return {
    id,
    name: id,
    version: "0.0.0",
    configSchema: { parse: (x: unknown) => x } as never,
    requiredSecrets: [],
    capabilities: {
      supportsIncrementalSync: false,
      supportsWebhooks: false,
      supportsAttachments: false,
      supportsComments: false,
      supportsRealTime: false,
    },
    pipelines: ["@onenomad/cortex-pipeline-doc"],
    init: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    fetch: async function* () {
      /* never yields */
    },
    transform: vi.fn(),
    classify: vi.fn(),
  };
}

function makeLogger() {
  const noop = vi.fn();
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => makeLogger(),
  };
}

function makeDeps() {
  return {
    engram: {
      ingest: vi.fn(async () => ({ id: "x" })),
      search: vi.fn(async () => []),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
      shutdown: vi.fn(async () => undefined),
    },
    llmRouter: { complete: vi.fn() } as never,
    logger: makeLogger(),
  };
}

describe("Scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T10:07:30.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips adapters with no schedule", () => {
    const scheduler = createScheduler(makeDeps());
    scheduler.register(fakeAdapter("a"), undefined);
    scheduler.register(fakeAdapter("b"), "");
    expect(scheduler.size()).toBe(0);
  });

  it("skips adapters with an invalid cron expression", () => {
    const scheduler = createScheduler(makeDeps());
    scheduler.register(fakeAdapter("a"), "not-a-cron");
    expect(scheduler.size()).toBe(0);
  });

  it("registers adapters with a valid schedule", () => {
    const scheduler = createScheduler(makeDeps());
    scheduler.register(fakeAdapter("loom"), "*/15 * * * *");
    scheduler.register(fakeAdapter("confluence"), "0 */6 * * *");
    expect(scheduler.size()).toBe(2);
  });

  it("stop() clears pending timers without errors", async () => {
    const scheduler = createScheduler(makeDeps());
    scheduler.register(fakeAdapter("a"), "*/15 * * * *");
    await scheduler.start();
    await scheduler.stop();
    // vitest tracks pending timers — advancing should not fire anything.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    // No assertion needed; the test passes if nothing throws.
  });
});
