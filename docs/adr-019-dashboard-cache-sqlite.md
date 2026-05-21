# ADR-019: Dashboard read-model cache in SQLite (2026-04-27)

**Status**: Accepted (Phase 1) — 2026-04-27. Phase 1 ships only the
`priorities` widget through the cache as a proof-of-concept. Phase 2
will wrap the remaining 7 widgets and add a background refresher;
Phase 3 adds stale-tag UI + hide-after-3 failure semantics. Original
draft authors: code-b7dc3fdc + code-7e662375.

## Context

The dashboard at `http://localhost:3030/` takes 2-5s to load and shows mixed-workspace data. Diagnosed:

- **Slow load.** 8 widgets × per-widget HTTP fetch to the sidecar × per-widget orchestration that may include Engram round-trips and LLM calls. ~9 round trips per render, all serial, no caching, page is `force-dynamic`. At 200-500ms per widget endpoint that's 1.6-4s of network time.
- **Workspace bleed.** Separate correctness bug — `renderWidget(entry)` doesn't thread `layout.workspace` to widgets. ADR-018 introduced session-scoped workspaces server-side via AsyncLocalStorage, but the dashboard fetches don't carry workspace as a query param so the sidecar never sees the right workspace context. **Fix is in flight on `feature/cortex-workspace-bleed` (Phase 1).** This ADR addresses Phase 2: the perf side.

Re-fetching the same data on every page render is wasteful for an ambient dashboard. Most widget content is "true within the last minute" — pre-meeting briefs change every few minutes, action-items change tens of times per day, code-activity once an hour.

## Decision

Add a **read-model cache in SQLite** between the widget sidecar handlers and the dashboard. New package `@onenomad/przm-cortex-cache-sqlite`.

### Storage model

- **Single SQLite file per host:** `<dataDir>/dashboard-cache.db`.
- **Per-widget table** with widget-shape columns plus three universal columns:
  - `workspace TEXT NOT NULL` — workspace slug, indexed for filtering
  - `cache_key TEXT NOT NULL` — hash of (queryParams) so different query shapes don't collide
  - `refreshed_at TEXT NOT NULL` — ISO timestamp
  - `payload_json TEXT NOT NULL` — the widget's typed Output as JSON (for shapes that don't decompose well into columns) OR per-row decomposition for shapes that do (priorities, action items)
  - `failure_count INTEGER NOT NULL DEFAULT 0` — consecutive refresh failures, for hide-after-3 policy
  - `last_error TEXT` — the most recent refresher error message (truncated)
  - PRIMARY KEY: `(workspace, cache_key)`
- **`cache_meta` table** for refresher coordination: widget name, last refresh attempt, last refresh success, configured cadence, current failure count.

### Refresher

- Lives in `packages/server/src/scheduler.ts` alongside the existing cron + heartbeat. Spawned on `cortex start`, not as a separate process. Single source of orchestration.
- **Per-widget cadences** declared in `config/dashboard.yaml`:
  ```yaml
  cache:
    refresh:
      priorities: 60s         # hot — user-facing
      my-action-items: 60s
      today-meetings: 30s     # hottest — calendar drift
      recent-activity: 120s
      recent-decisions: 300s
      upcoming-briefs: 300s
      code-activity: 600s     # cold — adapter-driven
      who-knows: 1800s
  ```
- **Refresher loop:**
  1. For each (widget, workspace) with a registered cadence, check `cache_meta.last_refresh_attempt + cadence < now`. If yes, schedule.
  2. Run the original widget handler with workspace context.
  3. On success: write payload + `refreshed_at = now`, reset `failure_count = 0`.
  4. On failure: increment `failure_count`, write `last_error`, leave previous payload in place. Log structured warn.
- **Workspace iteration:** for each cadence-due widget, iterate over the workspaces the user has registered. Single-workspace install = trivial. Multi-workspace = N × refresh per cadence; manageable since cadences are 30s+ and per-widget runtime is sub-second after warm caches.

### Read path

- Sidecar `/api/widgets/<name>` becomes a thin reader:
  ```ts
  async handler(query, ctx) {
    const workspace = ctx.workspace;
    const cacheKey = hashQuery(query);
    const row = cache.read(name, workspace, cacheKey);
    if (row && row.failure_count < 3) {
      return {
        ...JSON.parse(row.payload_json),
        _cache: {
          refreshed_at: row.refreshed_at,
          stale: now - row.refreshed_at > maxStale(name),
          failure_count: row.failure_count,
        },
      };
    }
    if (row && row.failure_count >= 3) {
      return { _cache: { hidden: true, reason: "refresh_failed_3x", last_error: row.last_error } };
    }
    // No cache row yet — first-load case. Compute synchronously, write, return.
    const fresh = await originalHandler(query, ctx);
    cache.write(name, workspace, cacheKey, fresh);
    return { ...fresh, _cache: { refreshed_at: now, stale: false, failure_count: 0 } };
  }
  ```
- Dashboard widgets render the `_cache.refreshed_at` as a small "Updated 23s ago" tag. When `_cache.hidden`, the widget renders an unobtrusive "data temporarily unavailable" placeholder.

### Failure semantics

Per agreed design (Q3 from coordination):
- **(a) Last-known-good with stale badge.** Default. Show data + "Updated 5m ago" tag.
- **(b) Hide after 3 consecutive failures.** Widget renders the placeholder. `_cache.last_error` available in dev tools or status endpoint for debugging. Resets when refresh succeeds.

### Migration path

1. Land workspace-bleed fix (Phase 1, in flight). Without it, cache caches wrong data.
2. Add `@onenomad/przm-cortex-cache-sqlite` package with schema migrations.
3. Add refresher to `cortex start` scheduler.
4. Wrap each widget sidecar handler with cache lookup. The wrapper is generic — handlers don't change.
5. Backfill: first dashboard load after upgrade triggers synchronous compute + write per widget. Subsequent loads hit cache.
6. Dashboard widget components add the `_cache` badge UI.

### Observability

- New counters: `cache.hits`, `cache.misses`, `cache.synchronous_computes`, `cache.refresh_successes`, `cache.refresh_failures`, `cache.hidden_widgets`.
- `cortex doctor` adds a `--cache` mode showing last refresh per (widget, workspace), failure counts, file size.
- `GET /api/cache-status` exposes structured cache-meta to dashboard "settings" page.

## Consequences

**Positive:**
- Dashboard load drops from 2-5s to 50-200ms.
- Widget endpoints survive Engram or LLM provider transient outages — last-known-good keeps showing.
- Decouples dashboard render path from MCP transport drops (mirrors synapse §1.5(b) lesson).
- Workspace-aware by construction.

**Negative:**
- Eventual consistency. Data is up to one cadence-cycle stale. Acceptable for ambient dashboard, surfaced via `_cache.refreshed_at` tag.
- Cache invalidation on configuration change (e.g., user edits `projects.yaml`) requires manual flush or a TTL bypass. Cheap mitigation: refresher detects config-file mtime change and forces refresh.
- Background refresher adds steady-state CPU. At default cadences across 8 widgets × 1 workspace = ~8 LLM/Engram calls per minute peak. Manageable.

**Open questions:**
1. **Should cache writes go through a transaction queue or direct SQLite WAL writes?** Lean direct WAL for simplicity; refresher is single-process so no contention.
2. **Schema-per-widget vs single payload-blob table?** Drafted as per-widget tables for indexability. If a widget gains rich filters (e.g., action-items by owner), per-row decomposition wins. If always-blob is fine, single table cuts schema migration cost. Lean per-widget tables given the existing typed Output interfaces.
3. **Multi-host federation?** Out of scope for this ADR; addressed by ADR-016 (`@onenomad/przm-cortex-memory-remote`) at the Engram layer, not the dashboard cache.
4. **Cache for the layout endpoint itself?** `fetchLayoutServer` runs on every render. Probably yes — same package, fixed-key row.

## Cross-references

- ADR-015 (local-per-user dashboard, HTTP sidecar) — this builds on it
- ADR-018 (session-scoped workspaces via AsyncLocalStorage) — workspace context flows through ctx
- ADR-012 (Engram + pgvector fallback) — cache sits above Engram, so Engram backend swap is transparent
- Synapse §1.5(b) (long-poll connection drops) — same pattern: don't block MCP transport on long ops, decouple via cache or async work queue

## Status

DRAFT — for review. Once accepted, implementation goes on `feature/cortex-cache-sqlite` after Phase 1 (workspace fix) lands on main.
