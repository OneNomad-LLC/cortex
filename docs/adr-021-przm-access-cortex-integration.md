# ADR-021: przm-access integration into cortex — multi-tenant RLS + Principal

**Status**: Accepted (shape + open questions resolved 2026-05-27; no code written yet — implementation gated on an explicit go, Phase 0 first). Implements PLAN §6/§8 step 3 of `../przm-access`. This is also cortex's standalone "multi-user knowledgebase" work and pays off regardless of the rest of the platform.

**Date**: 2026-05-27

---

## Context

`przm-access` milestone 1 shipped the identity/tenancy/access **spine** (branch `feat/milestone-1-identity-spine`, commit `ff9a668`): a thin contract package `@onenomad/przm-access` (`Principal` / `Role` / `TenantContext` / `Authorizer` + `defaultAuthorizer` + `withRlsSession`), a service with the tenant/user/project/membership/audit model behind `FORCE` RLS, EdDSA scoped-token issue/verify, WorkOS Classic SSO, and an admin API. cortex is the **first plane** to integrate it.

This ADR is grounded in cortex's *actual* wiring (verified, with file:line), not the platform vision:

| Surface | Reality today | File |
|---|---|---|
| **Transport** | stdio (default; local Claude Code subprocess; **no header channel**) **+** HTTP (`StreamableHTTPServerTransport`, session via `mcp-session-id` header). The HTTP path **already** has bearer auth: shared-secret (`PRZM_CORTEX_MCP_AUTH_TOKEN`), a **scoped-JWT** path (`verifyScopeToken` → `expandScopes` → per-session tool allow-list), gateway secret, and cookie session. | `packages/server/src/mcp/transport.ts:42`, `:98`, `:125-172`, `:260` |
| **Memory table** | One table; `workspace` is **nullable `TEXT`** (a slug), alongside `embedding vector(d)` and a generated `tsv`. No `tenant_id`, no `user`, no `role`. | `packages/memory-pgvector/src/schema.ts:34-60` |
| **Workspace scoping** | App-side only, via `$eqOrNull` → `(workspace = $N OR workspace IS NULL)`. The `OR … IS NULL` is a deliberate legacy-visibility hack: pre-session-binding rows show in **every** workspace. | `packages/memory-pgvector/src/queries.ts:143-145`, `:285-291` |
| **DB pool** | `PgPoolLike` is **`.query`-only** — a single auto-committed statement per call. **No `connect()` / transaction / role path.** True for both external (`pg`) and embedded (PGlite). | `packages/memory-pgvector/src/backend.ts:26`, `pool.ts:31-44`, `pglite.ts:53-89` |
| **Backend mode** | `external` (node-postgres + `connectionString`) \| `embedded` (PGlite, WASM, single in-process superuser). | `packages/server/src/clients/pgvector.ts:22` |
| **Dashboard identity** | GitHub OAuth + cookie session + workspace-scoped tokens. Establishes a *user*, but it is not mapped to any tenant/role model. | `packages/server/src/api/cookie-session.ts`, `routes/dashboard-auth-github.ts` |

**Three findings reshape the work** (in order of impact):

1. **The backend has no transaction-scoped query path.** RLS enforcement via `SET LOCAL app.tenant = …` *requires* a transaction (the `LOCAL` flag scopes the GUC to it and resets on COMMIT — otherwise it leaks onto the pooled connection). cortex's `PgPoolLike` is `pool.query`-only. **This is the largest single piece of work**: the external backend must grow a `withRlsSession`-style scoped path. It is the same gap flagged in przm-access's own `createPgPool`, but cortex-wide.
2. **PGlite cannot enforce RLS in production form.** It runs WASM as a single superuser. (Note: przm-access's M1 test *did* get `CREATE ROLE` + `SET LOCAL ROLE` + `FORCE RLS` working on PGlite for the isolation test — so the **test harness** is reusable — but a WASM single-process embedded DB is not where the multi-tenant security claim lives.) Therefore: **RLS is an external-Postgres-mode feature; embedded/PGlite stays app-layer-filtered and single-tenant.**
3. **`workspace` is a mutable slug; przm-access keys RLS on stable UUIDs** (przm-access PLAN §11.2). cortex needs a `tenant_id uuid` to key on; the slug stays human-facing.

---

## Decisions (proposed)

### D1 — RLS is external-Postgres-only; PGlite stays app-layer-filtered.
Embedded/local cortex remains single-tenant with today's `$eqOrNull` scoping and zero infra (honors przm-access KICKOFF constraint #3 and "must not break embedded PGlite mode"). The structural multi-tenant security claim applies to **cloud / external-Postgres** deployments. Both modes share one schema; RLS DDL is **guarded** so it only activates against external Postgres.

### D2 — Add a stable `tenant_id uuid` column; RLS keys on it, not the slug.
Add `tenant_id uuid` to the memory table. RLS policies enforce `tenant_id = current_setting('app.tenant')::uuid` (the przm-access pattern verbatim). `workspace` slug is retained for URLs/lookups/back-compat. The slug↔tenant_id mapping is owned by przm-access (the `tenant` table); cortex stamps `tenant_id` at ingest from the request's `Principal`.
- **Timing — RESOLVED (O1): add `tenant_id` now.** No production corpus exists, so adding the column + the embed/RLS seam is free today and a re-key migration later. Same logic as ADR-020.

### D3 — Adopt the `@onenomad/przm-access` contract; grow the external pool to a scoped session.
cortex imports the contract package and uses `withRlsSession(pool, principal, fn)`. The external `PgPoolLike` is extended to satisfy the contract's structural `RlsPool` (a `connect()` returning a transaction client). PGlite's pool stays `.query`-only and never enters this path. App-side `$eqOrNull` becomes **belt**; RLS is **suspenders**.

### D4 — Two DB roles in external mode (the prerequisite, shared with przm-access).
A privileged role runs bootstrap DDL/migrations; a **restricted, non-`BYPASSRLS`** role runs the query path (lowered via `SET LOCAL ROLE` or a separate restricted pool). Without this, a single privileged connection makes RLS silently *not* enforce — the exact cross-tenant-leak class the design exists to prevent. **This is the same gap flagged in przm-access `createPgPool`; fix it once, identically, in both repos (see Phase 0).**

### D5 — Token over MCP = the HTTP transport, mirroring the existing scoped-JWT path.
A przm-access EdDSA token rides the **same `Authorization: Bearer` channel** the scoped-JWT path already uses (transport.ts:151-162). On request: verify the token with the przm-access public key → build a `Principal` → stamp it on the session (exactly as `setSessionToolAllowList` stamps the allow-list) → thread it into the backend query path so `withRlsSession` gets the right tenant. **stdio stays single-tenant/local** (no header channel, and local single-user has no tenant). This resolves przm-access PLAN §9's "token transport must fit cortex's MCP transport": **yes, over HTTP**.

### D6 — Dashboard derives its Principal from the GitHub-login session.
The dashboard already establishes a user (GitHub OAuth + cookie). Map that user + active workspace → `Principal` (tenant from the workspace's `tenant_id`, role from membership) and run dashboard queries through `withRlsSession` too. This closes the Bug-2 class (the dashboard-memories cross-workspace leak) **structurally**, not by a remembered app filter.

### D7 — Legacy NULL-workspace rows do **not** survive into the multi-tenant world.
Under `tenant_id = current_setting('app.tenant')::uuid`, rows with NULL `tenant_id` match no tenant and disappear from RLS-scoped reads. That is correct for external/multi-tenant mode — the `$eqOrNull` "visible everywhere" hack is incompatible with isolation. **RESOLVED (O2): greenfield — accepted that NULL-`tenant_id` rows vanish under external RLS; no backfill.** Embedded mode keeps `$eqOrNull` unchanged.

---

## Phasing (each phase independently shippable)

- **Phase 0 — przm-access prerequisite (small).** Close the `createPgPool` two-role gap + add a real-Postgres RLS test (today RLS is proven only on PGlite). Makes the pattern cortex copies actually correct. *Lands in `../przm-access`, not cortex.*
- **Phase 1 — schema + policies (cortex, external-only).** Add `tenant_id uuid`; add RLS policies (`ENABLE` + `FORCE`, guarded to external mode) to the bootstrap DDL; provision the two roles. Prove with a cortex cross-tenant isolation test (reuse przm-access's PGlite-role harness now; add a real-PG CI job). **No behavior change for embedded.**
- **Phase 2 — scoped query path (cortex).** Grow the external `PgPoolLike` to a `withRlsSession`-capable shape; route external-mode reads/writes through it with the `Principal`. Keep `$eqOrNull` as the in-query belt.
  - **Phase 2a — DONE.** cortex adopts the published `@onenomad/przm-access` (devDependency for now); the RLS isolation test drives the cortex policies through the **real `withRlsSession`** — proving the contract helper + a scoped pool + the policy DDL isolate tenants end-to-end.
  - **Phase 2b — DONE.** The backend scoped-query path, **without** a przm-access runtime dep (keeps `memory-pgvector` self-contained + Apache-2.0). Design:
    - `PgPoolLike` gains an optional `withRlsScope(tenantId, fn)`; the external `createPgPool` implements it (`BEGIN` → `SET LOCAL ROLE <appRole>` → `set_config('app.tenant', tenantId, true)` → run `fn` → COMMIT). Embedded PGlite omits it.
    - `MemoryIngestInput` / `MemorySearchArgs` / `MemoryDeleteArgs` gain an optional `tenantId: string`. The backend routes ingest/search/delete through `withRlsScope(tenantId, …)` **only when** a `tenantId` is supplied AND the pool implements `withRlsScope`; otherwise the existing plain `pool.query` path runs (embedded / no tenant = byte-identical behavior). Ingest stamps `tenant_id`; reads/deletes need no SQL change — RLS does the filtering once `app.tenant` is set.
    - The backend deals only with a `tenantId` **string** — it never imports `@onenomad/przm-access`. The **server** owns the contract dependency and (Phase 3) derives `tenantId` from a verified `Principal`, passing it in the op args + supplying `appRole`/`enableRls` to `createPgVectorClient`.
    - Proven by `rls-backend-scope.test.ts`: `backend.ingest`/`search`/`delete` isolate by tenant through a `withRlsScope`-capable PGlite pool.
    - **Not yet wired:** admin/maintenance ops (`wipeAll`, `exportAll`) are not tenant-scoped — they have no per-request tenant context and stay on the unscoped path; revisit when an admin Principal exists.
  - **Phase 3 — next.** The `Principal` source: cortex's MCP **HTTP** transport verifies the przm-access EdDSA token (mirror the existing `verifyScopeToken` path, `transport.ts:125-172`) using the access public key (new config), reconstructs a `Principal`, stamps it on the session, and the tool handlers pass `principal.tenantId` into the backend op args. Plus config wiring to turn `enableRls`/`appRole` on, and the `workspace → tenant` reconciliation (the token's `tenantId` is authoritative; the workspace slug stays a human label). stdio stays single-tenant/local.
- **Phase 3 — token + dashboard (cortex).** Verify/thread the przm-access token on the HTTP transport → `Principal` → query path. Dashboard `Principal` from the GitHub session.
- **Phase 4 — project/role scoping.** Add the `app.projects` GUC + policy refinement and role-aware `authorize()` calls, once tenant isolation is solid.

---

## Honest risks / open questions

- **R1 — Transaction-per-op perf/pooling.** Moving external reads from `pool.query` to `connect → BEGIN → SET LOCAL → … → COMMIT` changes the concurrency profile and interacts with transaction-pooling (PgBouncer). Needs a perf check before Phase 2 ships.
- **R2 — RLS proven only on WASM.** Even with Phase 0, a real-Postgres CI job is required before any production multi-tenancy claim. PGlite ≠ Postgres on role/RLS edges.
- **R1 — Transaction-per-op perf/pooling** (above) — validated *during* Phase 2, not a blocker to accepting the shape.
- **R2 — RLS proven only on WASM** (above) — a real-Postgres CI job is required before any production multi-tenancy claim; tracked in Phase 1.
- **R3 — RESOLVED.** przm-access `tenant` table is the source of truth; cortex stamps `tenant_id` at ingest from the `Principal` and never resolves slugs itself in the hot path.
- **R4 — RESOLVED: contract package ships on public npm.** Originally planned private, but npmjs rejected a restricted publish without a paid plan (E402). The contract package is non-sensitive — types + `authorize()` + the RLS helper, no secrets or business logic (the proprietary value is the unpublished service) — so the owner chose public distribution. Published as **`@onenomad/przm-access@0.1.0`** (`publishConfig.access: "public"`); cortex consumes it as an ordinary versioned dependency, same as the public `przm-cortex-*` packages, no auth token needed. (License stays `UNLICENSED` — source-visible, all-rights-reserved.)
- **O1 — RESOLVED: add `tenant_id` now** (greenfield = free; later = re-key migration).
- **O2 — RESOLVED: greenfield** — NULL-`tenant_id` rows vanish under external RLS; no backfill.

---

## What this is NOT

- Not SpiceDB/ReBAC (przm-access decided RLS + roles; unchanged).
- Not a change to embedded/local cortex's behavior or zero-infra promise.
- Not a stdio-transport auth scheme (stdio = local single-tenant by design).
- Not yet implemented — the shape is accepted and logged in `DECISIONS.md`, but **no code is written**. Implementation starts at Phase 0 (in `../przm-access`) on an explicit go.
