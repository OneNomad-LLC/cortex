import { createHash } from "node:crypto";
import type { CacheStorage } from "@onenomad/przm-cortex-cache-sqlite";
import type { Widget, WidgetContext } from "../types.js";

/**
 * ADR-019 Phase 1+2 — wrap a widget handler with a SQLite cache layer.
 *
 * On each request: compute (workspace, cache_key) from ctx + query,
 * read the cache, then decide based on the entry's age:
 *
 *   age <= ttlSeconds         → fresh, return cached payload as-is
 *   age <= ttl + staleSeconds → stale-but-serveable, return cached
 *                               payload AND fire a background refresh
 *                               (deduped per key) to refill the cache
 *   age > ttl + staleSeconds  → past serveable window, recompute
 *                               synchronously like a miss
 *   miss / payload=null       → recompute synchronously
 *
 * `ttlSeconds: undefined` (the default) preserves the original Phase 1
 * behavior: any cached value is fresh forever. Existing call sites that
 * passed no opts keep working without change.
 *
 * Phase 3 (failure-streak hide-after-3 UI) still pending — recordFailure
 * is invoked on misses, but the wrapper doesn't yet read failureCount.
 */
export interface WithCacheOptions {
  /**
   * Seconds a cached payload is considered fresh. Older than this, the
   * SWR window kicks in. Omit (or 0) to disable expiry — the cache then
   * acts like the Phase 1 implementation.
   */
  ttlSeconds?: number;
  /**
   * Seconds beyond `ttlSeconds` we still serve the stale value while a
   * background refresh runs. Defaults to a generous window so steady-
   * state dashboard loads stay fast even when the underlying engram
   * call has gone slow. Set to 0 to opt out of SWR (stale = synchronous
   * recompute).
   */
  staleSeconds?: number;
}

export function withCache<T>(
  widget: Widget<T>,
  cache: CacheStorage,
  opts: WithCacheOptions = {},
): Widget<T> {
  const ttlSeconds = opts.ttlSeconds;
  const staleSeconds = opts.staleSeconds ?? 24 * 60 * 60;
  // Per-key inflight map so concurrent requests during a stale window
  // don't all kick off duplicate background refreshes. Closure-scoped:
  // one map per wrapped widget instance.
  const inflight = new Map<string, Promise<unknown>>();

  return {
    name: widget.name,
    description: widget.description,
    async handler(query: URLSearchParams, ctx: WidgetContext): Promise<T> {
      const workspaceSlug = ctx.workspace?.slug ?? "";
      const cacheKey = makeCacheKey(query);
      const dedupeKey = `${workspaceSlug}:${cacheKey}`;

      const hit = cache.read(widget.name, workspaceSlug, cacheKey);
      // payload === null is the failure sentinel from recordFailure()
      // before any successful write — treat as miss so the next attempt
      // gets a real value into the cache.
      if (hit && hit.payload !== null) {
        const ageSeconds = ageInSeconds(hit.refreshedAt);
        const fresh =
          ttlSeconds === undefined || ttlSeconds <= 0
            ? true
            : ageSeconds <= ttlSeconds;
        if (fresh) {
          return hit.payload as T;
        }
        const ttl = ttlSeconds ?? 0;
        if (staleSeconds > 0 && ageSeconds <= ttl + staleSeconds) {
          // Stale but serveable: kick off a background refresh (deduped
          // per cache key) and return the stale payload immediately so
          // the request finishes fast.
          if (!inflight.has(dedupeKey)) {
            const p = refreshAndStore(
              widget,
              cache,
              query,
              ctx,
              workspaceSlug,
              cacheKey,
            )
              .catch(() => undefined)
              .finally(() => inflight.delete(dedupeKey));
            inflight.set(dedupeKey, p);
          }
          return hit.payload as T;
        }
        // Past the stale window — fall through to a synchronous
        // recompute so the user sees current data.
      }

      return refreshAndStore(
        widget,
        cache,
        query,
        ctx,
        workspaceSlug,
        cacheKey,
      );
    },
  };
}

async function refreshAndStore<T>(
  widget: Widget<T>,
  cache: CacheStorage,
  query: URLSearchParams,
  ctx: WidgetContext,
  workspaceSlug: string,
  cacheKey: string,
): Promise<T> {
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
    try {
      cache.recordFailure(widget.name, workspaceSlug, cacheKey, message);
    } catch {
      // never let cache bookkeeping mask the original error
    }
    throw err;
  }
}

function ageInSeconds(refreshedAtIso: string): number {
  const t = Date.parse(refreshedAtIso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 1000;
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
