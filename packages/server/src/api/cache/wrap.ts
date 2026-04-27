import { createHash } from "node:crypto";
import type { CacheStorage } from "@onenomad/cortex-cache-sqlite";
import type { Widget, WidgetContext } from "../types.js";

/**
 * ADR-019 Phase 1 — wrap a widget handler with a SQLite cache layer.
 *
 * On each request: compute (workspace, cache_key) from ctx + query,
 * try a cache read; on hit return the stored payload immediately, on
 * miss compute the underlying handler and write the result back.
 *
 * Phase 1 deliberately does NOT include:
 *   - background refresh (Phase 2)
 *   - stale-while-revalidate / TTL (Phase 2)
 *   - failure-streak hide-after-3 UI (Phase 3)
 *
 * Cache misses pay full handler latency synchronously. That's fine in
 * Phase 1 because cold start is rare; the hot path (steady-state
 * dashboard refresh) gets the full speedup.
 */
export function withCache<T>(widget: Widget<T>, cache: CacheStorage): Widget<T> {
  return {
    name: widget.name,
    description: widget.description,
    async handler(query: URLSearchParams, ctx: WidgetContext): Promise<T> {
      const workspaceSlug = ctx.workspace?.slug ?? "";
      const cacheKey = makeCacheKey(query);

      const hit = cache.read(widget.name, workspaceSlug, cacheKey);
      // payload === null is the failure-sentinel shape from
      // recordFailure() before any successful write — treat as miss
      // so a fresh attempt gets a real value into the cache.
      if (hit && hit.payload !== null) {
        return hit.payload as T;
      }

      try {
        const fresh = await widget.handler(query, ctx);
        cache.write(
          widget.name,
          workspaceSlug,
          cacheKey,
          fresh,
          new Date().toISOString(),
        );
        return fresh;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try { cache.recordFailure(widget.name, workspaceSlug, cacheKey, message); }
        catch { /* never let cache bookkeeping mask the original error */ }
        throw err;
      }
    },
  };
}

/**
 * Stable cache key from query params. SHA-256 truncated to 16 hex chars
 * — collision probability for the small param-space dashboards generate
 * (a handful of distinct query shapes per widget) is negligible.
 *
 * Sort the entries so `?days=7&limit=10` and `?limit=10&days=7` hash
 * identically — same request, one cache row.
 */
function makeCacheKey(query: URLSearchParams): string {
  const entries: string[] = [];
  // URLSearchParams iterator yields in insertion order; sort to canonicalize.
  for (const [k, v] of query) entries.push(`${k}=${v}`);
  entries.sort();
  return createHash("sha256").update(entries.join("&")).digest("hex").slice(0, 16);
}
