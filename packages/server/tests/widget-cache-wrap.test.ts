import { describe, expect, it } from "vitest";
import { withCache } from "../src/api/cache/wrap.js";
import type { Widget, WidgetContext } from "../src/api/types.js";
import type { CacheStorage, CacheReadResult } from "@onenomad/cortex-cache-sqlite";

interface FakeOps {
  reads: Array<{ widget: string; workspace: string; key: string }>;
  writes: Array<{ widget: string; workspace: string; key: string; payload: unknown }>;
  failures: Array<{ widget: string; workspace: string; key: string; error: string }>;
}

function makeFakeCache(opts: { hit?: CacheReadResult } = {}): {
  cache: CacheStorage;
  ops: FakeOps;
} {
  const ops: FakeOps = { reads: [], writes: [], failures: [] };
  const cache: CacheStorage = {
    read(widget, workspace, key) {
      ops.reads.push({ widget, workspace, key });
      return opts.hit ?? null;
    },
    write(widget, workspace, key, payload) {
      ops.writes.push({ widget, workspace, key, payload });
    },
    recordFailure(widget, workspace, key, error) {
      ops.failures.push({ widget, workspace, key, error });
    },
    close() {},
  };
  return { cache, ops };
}

function fakeCtx(): WidgetContext {
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child(): WidgetContext["logger"] { return this; },
    } as never,
    engram: {} as never,
    llmRouter: {} as never,
    taxonomy: {} as never,
  };
}

function fakeWidget<T>(impl: (q: URLSearchParams) => Promise<T> | T): Widget<T> {
  return {
    name: "test-widget",
    description: "test",
    async handler(query) { return await impl(query); },
  };
}

describe("withCache wrapper", () => {
  it("cache miss → calls inner handler + writes result", async () => {
    let callCount = 0;
    const inner = fakeWidget(async () => {
      callCount += 1;
      return { rows: ["a", "b"] };
    });
    const { cache, ops } = makeFakeCache({ hit: undefined });
    const wrapped = withCache(inner, cache);
    const result = await wrapped.handler(new URLSearchParams("limit=5"), fakeCtx());
    expect(result).toEqual({ rows: ["a", "b"] });
    expect(callCount).toBe(1);
    expect(ops.reads.length).toBe(1);
    expect(ops.writes.length).toBe(1);
    expect(ops.writes[0]!.payload).toEqual({ rows: ["a", "b"] });
  });

  it("cache hit → returns cached payload, skips inner handler", async () => {
    let callCount = 0;
    const inner = fakeWidget(async () => {
      callCount += 1;
      return { fresh: true };
    });
    const { cache } = makeFakeCache({
      hit: {
        payload: { fresh: false, fromCache: true },
        refreshedAt: "2026-04-27T00:00:00.000Z",
        failureCount: 0,
        lastError: null,
      },
    });
    const wrapped = withCache(inner, cache);
    const result = await wrapped.handler(new URLSearchParams("limit=5"), fakeCtx());
    expect(result).toEqual({ fresh: false, fromCache: true });
    expect(callCount).toBe(0);
  });

  it("cache key is order-independent", async () => {
    const inner = fakeWidget(async () => ({ ok: true }));
    const { cache, ops } = makeFakeCache();
    const wrapped = withCache(inner, cache);
    await wrapped.handler(new URLSearchParams("a=1&b=2"), fakeCtx());
    await wrapped.handler(new URLSearchParams("b=2&a=1"), fakeCtx());
    expect(ops.reads.length).toBe(2);
    expect(ops.reads[0]!.key).toBe(ops.reads[1]!.key);
  });

  it("workspace from ctx.workspace.slug becomes cache workspace; absent → empty string", async () => {
    const inner = fakeWidget(async () => ({ ok: true }));
    const { cache, ops } = makeFakeCache();
    const wrapped = withCache(inner, cache);

    await wrapped.handler(new URLSearchParams(), fakeCtx());
    expect(ops.reads[0]!.workspace).toBe("");

    const ctx = fakeCtx();
    (ctx as { workspace?: { slug: string } }).workspace = { slug: "work" };
    await wrapped.handler(new URLSearchParams(), ctx);
    expect(ops.reads[1]!.workspace).toBe("work");
  });

  it("inner handler throws → recordFailure called, error rethrown", async () => {
    const inner = fakeWidget(async () => {
      throw new Error("engram timeout");
    });
    const { cache, ops } = makeFakeCache();
    const wrapped = withCache(inner, cache);
    await expect(
      wrapped.handler(new URLSearchParams(), fakeCtx()),
    ).rejects.toThrow("engram timeout");
    expect(ops.failures.length).toBe(1);
    expect(ops.failures[0]!.error).toBe("engram timeout");
    expect(ops.writes.length).toBe(0);
  });

  it("hit with payload=null (failure sentinel) treated as miss", async () => {
    let callCount = 0;
    const inner = fakeWidget(async () => {
      callCount += 1;
      return { recovered: true };
    });
    const { cache, ops } = makeFakeCache({
      hit: {
        payload: null,
        refreshedAt: "2026-04-27T00:00:00.000Z",
        failureCount: 2,
        lastError: "prior failure",
      },
    });
    const wrapped = withCache(inner, cache);
    const result = await wrapped.handler(new URLSearchParams(), fakeCtx());
    expect(result).toEqual({ recovered: true });
    expect(callCount).toBe(1);
    expect(ops.writes.length).toBe(1);
  });

  it("ttlSeconds: fresh hit (within TTL) skips inner handler", async () => {
    let callCount = 0;
    const inner = fakeWidget(async () => {
      callCount += 1;
      return { fresh: true };
    });
    const { cache } = makeFakeCache({
      hit: {
        payload: { fromCache: true },
        refreshedAt: new Date(Date.now() - 10_000).toISOString(),
        failureCount: 0,
        lastError: null,
      },
    });
    const wrapped = withCache(inner, cache, { ttlSeconds: 60 });
    const result = await wrapped.handler(new URLSearchParams(), fakeCtx());
    expect(result).toEqual({ fromCache: true });
    expect(callCount).toBe(0);
  });

  it("ttlSeconds + SWR: stale hit returns cached AND fires bg refresh", async () => {
    let callCount = 0;
    const inner = fakeWidget(async () => {
      callCount += 1;
      // Slow handler — we should NOT block on this in the SWR path.
      await new Promise((r) => setTimeout(r, 5));
      return { fresh: true };
    });
    const { cache, ops } = makeFakeCache({
      hit: {
        payload: { fromCache: true },
        refreshedAt: new Date(Date.now() - 120_000).toISOString(),
        failureCount: 0,
        lastError: null,
      },
    });
    const wrapped = withCache(inner, cache, {
      ttlSeconds: 60,
      staleSeconds: 600,
    });
    const result = await wrapped.handler(new URLSearchParams(), fakeCtx());
    // First request returns the stale value immediately.
    expect(result).toEqual({ fromCache: true });
    // Background refresh has been scheduled but hasn't completed yet.
    // Wait for it to finish, then assert the cache was rewritten.
    await new Promise((r) => setTimeout(r, 30));
    expect(callCount).toBe(1);
    expect(ops.writes.length).toBe(1);
    expect(ops.writes[0]!.payload).toEqual({ fresh: true });
  });

  it("ttlSeconds + SWR: concurrent stale requests dedupe to ONE bg refresh", async () => {
    let callCount = 0;
    let resolveInner: ((v: { fresh: true }) => void) | undefined;
    const inner = fakeWidget(
      () =>
        new Promise<{ fresh: true }>((resolve) => {
          callCount += 1;
          resolveInner = resolve;
        }),
    );
    const { cache } = makeFakeCache({
      hit: {
        payload: { fromCache: true },
        refreshedAt: new Date(Date.now() - 120_000).toISOString(),
        failureCount: 0,
        lastError: null,
      },
    });
    const wrapped = withCache(inner, cache, {
      ttlSeconds: 60,
      staleSeconds: 600,
    });

    // Fire three stale requests in flight at the same time.
    const [a, b, c] = await Promise.all([
      wrapped.handler(new URLSearchParams(), fakeCtx()),
      wrapped.handler(new URLSearchParams(), fakeCtx()),
      wrapped.handler(new URLSearchParams(), fakeCtx()),
    ]);
    expect(a).toEqual({ fromCache: true });
    expect(b).toEqual({ fromCache: true });
    expect(c).toEqual({ fromCache: true });
    // Only ONE bg refresh kicked off despite three requests.
    expect(callCount).toBe(1);

    // Let the bg refresh complete so the test doesn't leak a pending
    // promise into the next case.
    resolveInner?.({ fresh: true });
    await new Promise((r) => setTimeout(r, 5));
  });

  it("ttlSeconds + SWR: past stale window forces synchronous recompute", async () => {
    let callCount = 0;
    const inner = fakeWidget(async () => {
      callCount += 1;
      return { fresh: true };
    });
    const { cache, ops } = makeFakeCache({
      hit: {
        payload: { fromCache: true },
        // ttl(60) + stale(60) = 120s window. We're 200s old.
        refreshedAt: new Date(Date.now() - 200_000).toISOString(),
        failureCount: 0,
        lastError: null,
      },
    });
    const wrapped = withCache(inner, cache, {
      ttlSeconds: 60,
      staleSeconds: 60,
    });
    const result = await wrapped.handler(new URLSearchParams(), fakeCtx());
    expect(result).toEqual({ fresh: true });
    expect(callCount).toBe(1);
    expect(ops.writes.length).toBe(1);
  });

  it("ttlSeconds=undefined (Phase 1 behavior): hits never expire", async () => {
    let callCount = 0;
    const inner = fakeWidget(async () => {
      callCount += 1;
      return { fresh: true };
    });
    const { cache } = makeFakeCache({
      hit: {
        payload: { fromCache: true },
        refreshedAt: "2020-01-01T00:00:00.000Z",
        failureCount: 0,
        lastError: null,
      },
    });
    // No opts — same call shape as the original Phase 1 tests.
    const wrapped = withCache(inner, cache);
    const result = await wrapped.handler(new URLSearchParams(), fakeCtx());
    expect(result).toEqual({ fromCache: true });
    expect(callCount).toBe(0);
  });
});
