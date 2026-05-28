# Changelog

All notable changes to Cortex will be documented in this file.

## Unreleased (0.7.1)

**Bootstrap fix (important)**: v0.7.0's `tsv` generated column (ADR-020) was invalid DDL — Postgres forbids subqueries inside a `GENERATED ALWAYS` expression, and the idempotent upgrade `DO` block called `pg_get_expr(attgenerated, …)` on the wrong catalog column. Either fault made `bootstrap()` throw on a real engine, so v0.7.0 could not initialize a fresh database (or upgrade a pre-ADR-020 one) on Postgres **or** embedded PGlite. The existing tests used a fake pool, so neither was caught. A patch release is warranted.

- fix(memory-pgvector): move the ADR-020 keyword projection into an `IMMUTABLE` `<table>_kw_text(jsonb)` function the generated column calls (subqueries are legal inside a function, not inline in a generation expression). Behavior is unchanged — a row without `summary`/`keywords` still yields the identical `tsv` as `content` alone.
- fix(memory-pgvector): the tsv-upgrade `DO` block now reads the generation expression from `pg_attrdef.adbin` instead of `pg_attribute.attgenerated`, so the idempotent migration detection actually runs.
- feat(memory-pgvector): ADR-021 Phase 1 — add a nullable `tenant_id uuid` column + index, and opt-in row-level-security DDL (`enableRls`, **external Postgres only**, off by default). When enabled, `ENABLE`/`FORCE` RLS with tenant policies keyed on `tenant_id = current_setting('app.tenant')`. Embedded PGlite is never given RLS (it would hide every row in single-user mode). A real-PGlite cross-tenant isolation test proves A cannot read/update/delete/insert B's rows, with a sanity guard that RLS isn't silently bypassed.
- feat(server): `createPgVectorClient` accepts `enableRls`, honored only in `external` mode.
- test(memory-pgvector): the RLS isolation suite now drives cortex's policies through the **real `withRlsSession`** from `@onenomad/przm-access` (a devDependency) — the Phase 2a end-to-end integration proof that the published contract helper, a scoped pool, and the cortex policy DDL isolate tenants together.
- docs: ADR-021 (przm-access → cortex integration) accepted; the multi-tenant RLS substrate lands across five phases. Phase 0 (RLS hardening + publishable contract) shipped in przm-access; Phase 1 (schema + policies) and Phase 2a (contract adoption + integration proof) here. R4 resolved: `@onenomad/przm-access` is published Apache-2.0 (v0.1.1) on public npm.

## v0.7.0 — 2026-05-27

**Behavior changes**: (1) retrieval now down-ranks `experimental` / `external` `trust` memories by default (pass `minTrust` to exclude them outright); (2) the dashboard "Connectors" page is merged into **Adapters** (`/connectors` → `/adapters` redirect kept) and `/` now lands on `/stats`; (3) `get_session_workspace` suggests your last-active workspace when a session is unbound and `set_session_workspace` records it, so new sessions can resume. **Schema migration**: the `tsv` full-text column now composes `content + summary + keywords`; existing deployments upgrade via an idempotent `DO` block on bootstrap (or recreate the table). Rows without enrichment produce the identical `tsv` as before.

- feat(server): LLM ingest extractors (ADR-020) — opt-in `summary` + `keywords` extractors, **off by default**, run only when an LLM provider is configured; prompts as `.md`. Outputs compose into the embedding (`embedText`) and the `tsv` full-text column. Default behavior is byte-identical when disabled; a retrieval eval demonstrates recall lift on jargon-gap queries.
- feat(core): metadata contract gains optional `summary` + `keywords`; a conformance test enforces the Zod schema and `schemas/memory-metadata.json` stay in sync (and reconciles prior `project` / `due_date` / `urgency` / `mentions_me` / `owner` drift).
- feat(server): retrieval governance — optional `maxSensitivity` filter and `minTrust` strict exclusion on search; default soft down-rank of untrusted memories.
- feat(memory-pgvector): content-addressed SHA-256 embedding cache (bounded, pure memoization) + a Mongo-style filter translator (`$eq` / `$in` / `$gte` / `$eqOrNull` / `$inOrNull` / `$and` / `$or`) routing the existing WHERE predicates, behavior-preserving.
- fix(server): session→workspace binding persists (hybrid resume); dashboard memories scope to the active workspace instead of leaking across all workspaces.
- feat(dashboard): Connectors merged into a single Adapters page, `/` → `/stats`, loading skeletons + consistent empty / error states, de-jargoned copy, first-run callouts.
- refactor(server): retire the dead engram-subprocess client path left from the 0.3 pgvector migration; remove a stale dashboard shim.
- docs: CLAUDE.md posture updated to a cloud multi-tenant / multi-project / multi-user knowledgebase; ADR-020 logged.


## v0.6.0 — 2026-05-22

**Behavior change**: `ingest_repo` now defaults to `mode: 'dossier'` — produces a small set of high-signal memories describing the repo (architectural brief, ADR decisions, public API references) instead of dumping every source file as chunks. The legacy per-file walk is still available via `mode: 'full'`, and `mode: 'both'` runs both pipelines. Existing scheduled GitHub syncs flip to dossier mode unless `mode: 'full'` or per-repo `repoModes` override is set in `cortex.yaml`.

- feat(pipeline-code-dossier): new package — 3-pass LLM extraction (structural → synthesis → brief) over README / ARCHITECTURE.md / CLAUDE.md / AGENTS.md / docs/DECISIONS.md / docs/ADR-*.md / CHANGELOG.md / package manifests / entry points. Emits 1 `brief` + N `decision` (per ADR) + N `reference` (per API surface) memories. Graceful degradation when no LLM provider is configured (structural-only brief).
- feat(ingest_repo): `mode: 'dossier' | 'full' | 'both'` parameter (default `dossier`) + `skipIfUnchanged: boolean` (default `true`) for SHA-gated re-derivation over dossier-input files. Skipped runs return `{ skipped: true, skipReason: 'unchanged', priorJobId }`.
- feat(adapter-github): `mode` config field (default `dossier`) + per-repo `repoModes` overrides. Wizard step + per-repo override step. `fetch()` delegates to `ingest_repo` via injected `setRepoIngester` seam (avoids circular dep). SETUP.md rewritten to lead with dossier semantics.
- feat(dashboard): `/_dashboard/memories` browser — paginated list with type / source / project / since / query filters, dossier badge on `type:brief` + `tag:dossier`, detail modal with markdown rendering.
- feat(dashboard): GitHub Repos page — per-row "Knowledge mode" dropdown (Dossier / Full / Both / Adapter default), persists to `cortex.yaml` `repoModes`. Bulk-sync threads per-row mode overrides.
- feat(dashboard): Connectors GitHub card surfaces current adapter-level mode as subtitle.
- feat(server): `wireGithubRepoIngester` at boot binds adapter ingester to `ingest_repo.handler` with `toolContext` — scheduled syncs now route through the mode-aware pipeline.
- feat(server): `GET/POST /api/dashboard/memories` admin-gated routes; `POST /api/dashboard/github/repos/:owner/:name/mode` for per-repo mode persistence; `GET /api/dashboard/github/repos` rows extended with `mode` / `adapterMode` / `modeOverride`.


## v0.5.1 — 2026-05-22

- feat(auth): bridge GitHub OAuth token → adapter config on sign-in


## v0.5.0 — 2026-05-22

- feat(dashboard): Access settings page + cortex-init allowlist prompt
- feat: integrate v0.5.0 slices + must-fixes + cheap wins
- feat(dashboard): GitHub UI slice — login flow, repos table, connectors directory
- feat(server): github repos dashboard API + cortex_github_ingest_repo MCP tool
- feat(server): add GitHub Device Flow OAuth dashboard sign-in + persistent sessions (Slice A)


## v0.4.6 — 2026-05-21

- fix(dashboard): drop /_dashboard prefix from in-app navigation hrefs


## v0.4.5 — 2026-05-21

- fix(server): depend on @onenomad/przm-cortex-dashboard so npm install pulls in the SPA


## v0.4.4 — 2026-05-21

- feat(dashboard): make package publishable + npm-aware dist resolution


## v0.4.3 — 2026-05-21

- fix(release): always pnpm -r build before publish


## v0.4.2 — 2026-05-21

- fix(release): drop SIGPIPE-prone 'git log | head -1' in CHANGELOG window
- chore(release): add scripts/release.sh + pnpm release shortcuts
- feat(deploy): cortex update CLI + GHCR image publishing
- fix(dashboard): reconcile shell+wizard+ops integration
- feat(dashboard): Ops slice — jobs persistence + logs/jobs/stats/ingest routes + SPA pages
- feat(dashboard): wizard renderer + adapter management (Phase 2)
- feat(dashboard): shell — router, auth helpers, workspaces, identity (Phase 2)
- feat(dashboard): token-based auth — CLI + middleware + login/logout/whoami
- feat(dashboard): scaffold @onenomad/przm-cortex-dashboard SPA + /_dashboard route
- release: 0.4.1 — ship wizard fixes
- chore(wizard): bring init wizard up to date for przm-cortex 0.4
- release: 0.4.0 — przm-cortex publish-ready
- chore: regenerate pnpm lockfile after package renames
- docs: fix stale Engram/Persona dependency claims + rename identifiers
- rename(deploy): cortex-base/workers → przm-cortex-base/workers, CORTEX_* → PRZM_CORTEX_*
- rename(source): CORTEX_* env vars → PRZM_CORTEX_* + update package imports
- rename(packages): @onenomad/cortex-* → @onenomad/przm-cortex-*
- Merge pull request #65 from OneNomad-LLC/development
- fix(boot): reload cortex config after seed_llm_provider mutates disk (#64)
- Merge pull request #63 from OneNomad-LLC/development
- feat(enrichment): auto-extract action items + decisions on ingest (#62)
- Merge pull request #61 from OneNomad-LLC/development
- fix(memory): useLocalEmbedder flag — pin embeddings to Xenova when LLM provider can't embed (#60)
- Merge pull request #59 from OneNomad-LLC/development
- feat(bootstrap): seedLlmProviderFromEnv — auto-wire openrouter on first boot (#58)
- Merge pull request #57 from OneNomad-LLC/development
- docs: AGENTS.md — drop-in instructions for AI agents using the OneNomad trio (#56)
- Merge pull request #55 from OneNomad-LLC/development
- feat(worker): execute claimed jobs by calling tenant invoke endpoint (P2.3) (#54)
- Merge pull request #53 from OneNomad-LLC/development
- feat(cli): cortex worker entrypoint + cortex-workers Fly config (P2.1) (#52)
- Merge pull request #51 from OneNomad-LLC/development
- feat(jobs): per-process concurrency cap on background ingest runner (#50)
- feat(ingest): default async=true on ingest_repo and ingest_url (#49)
- Merge pull request #48 from OneNomad-LLC/development
- fix(workspace): use workspace:* for internal cortex deps in server + memory-remote (#47)
- Merge pull request #46 from OneNomad-LLC/development
- fix(docker): install ca-certificates so git can clone over HTTPS (#45)
- Merge pull request #44 from OneNomad-LLC/development
- feat(onboarder): @onenomad/cortex-onboarder MCP package for friction-free Cortex login (#43)
- chore: add TRADEMARK.md alongside Apache 2.0 LICENSE (#42)
- Merge pull request #41 from OneNomad-LLC/development
- feat: absorb cortex-kit packages back into cortex monorepo (#40)
- chore: consume cortex-kit packages from npm (#39)


The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-05-21

### Fixed
- **`przm-cortex init` wizard** brought up to date for cortex 0.4: removed the vestigial "Engram and Persona" pre-flight step (cortex 0.3 dropped those companion-MCP dependencies per ADR-012 — `detectDeps()` already returned `[]`, but the wizard section header still ran and confused new users). Removed `ENGRAM_MCP_URL` / `PERSONA_MCP_URL` from the generated `.env`. Renamed `cortex <verb>` examples in user-facing messages to `przm-cortex <verb>` (the unscoped `cortex` bin still works as a backward-compat alias).
- **Generated `cortex.yaml` default memory backend** changed from `engram` to `pgvector` with `useLocalEmbedder: true` (bundled Xenova/all-MiniLM-L6-v2). Fresh installs were writing a config that pointed at an MCP service the runtime no longer consumed.

## [0.4.0] - 2026-05-21

### Changed
- **Brand rename: `cortex` → `przm-cortex`.** The npm package previously published (or scheduled to publish) as `@onenomad/cortex` is now `@onenomad/przm-cortex`. Every internal workspace package follows the same pattern: `@onenomad/cortex-*` → `@onenomad/przm-cortex-*`. The cortex CLI binary keeps the unscoped `cortex` alias for backward compatibility, with `przm-cortex` as the canonical name. Brings cortex into the przm-* family alongside `@onenomad/przm-memory` and `@onenomad/przm-voice`.
- **Environment variable prefix: `CORTEX_*` → `PRZM_CORTEX_*`.** All runtime env vars (`CORTEX_HOME`, `CORTEX_MCP_TRANSPORT`, `CORTEX_MCP_PORT`, `CORTEX_MCP_AUTH_TOKEN`, etc.) renamed to `PRZM_CORTEX_*`. Self-host operators upgrading from 0.3.x: update systemd unit `Environment=` lines and any `.env` files.
- **First public release of the workspace packages.** Every package previously at `0.1.0` (workspace-internal) is now `0.4.0` and published to npm under the Apache-2.0 license. The server (`@onenomad/przm-cortex`) ships with `publishConfig.access: public` so global install (`npm install -g @onenomad/przm-cortex`) works end-to-end.

### Fixed
- **Stale "built on top of Engram/Persona" claims** in `README.md`, `CLAUDE.md`, and `AGENTS.md` removed. As of ADR-012 (2026-04-22), cortex no longer consumes Engram (now `@onenomad/przm-memory`) at runtime — its memory layer is the bundled pgvector backend. Docs now reflect that.

### Removed
- `docs/handoffs/cortex-evaluation-2026-05-21.md` — internal work-in-progress note that shouldn't have shipped publicly.

### Added
- **Auto-enrichment on `ingest_content`** — when the workspace has an LLM router wired and the content type is `doc` / `note` / `meeting` / `conversation`, every successful ingest now fires a one-shot extraction pass that pulls structured items out of the body and persists each as its own memory:
  - **action_items** with `owner:<slug>`, `due:<iso>`, `priority:P*`, `status:open` tags so the dashboard's by-type widgets pick them up
  - **decisions** with the summary as title and optional context appended
  - **entities** (people / projects / products / companies / events) — counted in the response, not persisted yet (would flood the KB; routing into `add_person` / `add_project` is a follow-up)
  - Cost: one LLM call per ingest, ~$0.0002 at gpt-4o-mini Azure pricing. Skipped silently when no router is configured. Failure does NOT fail the ingest — raw chunks always land first; enrichment is a layered side-effect.
  - Implementation: new `enrichment/extract-structured-items.ts` runs the prompt + parses JSON with tolerant cleanup, hooked into `ingest_content` after the chunk write loop. `ingest_repo` / `ingest_url` / `ingest_file` inherit enrichment automatically since they route through `ingest_content`.
  - Response shape gains an `enriched: { actionItems, decisions, entities }` block so callers can see what extracted.
- **`memory.pgvector.useLocalEmbedder` config flag** — pin embeddings to the bundled Xenova model even when an LLM router is wired. Required when the configured provider is chat-only (Azure gpt-4o-mini, Anthropic). Set automatically by `seedLlmProviderFromEnv` since the openrouter-shim path is almost always pointed at a chat model.
- **`seedLlmProviderFromEnv`** — env-driven LLM provider bootstrap so a fresh Cortex Cloud tenant comes up enrichment-capable without an SSH-and-patch step. Reads `OPENROUTER_API_KEY` + `CORTEX_LLM_BASE_URL` + `CORTEX_LLM_DEFAULT_MODEL`, applies the openrouter wizard, stamps the default LLM task, pins local embeddings.
- **`setDefaultLlmTask` + `setUseLocalEmbedder` helpers** in `cli/config-mutation.ts` — programmatic config writes that other parts of the system (CLI, tests, future admin endpoints) can reuse.
- **`cortex worker` subcommand** — long-running entrypoint for the przm-cortex-workers Fly fleet. Polls pyre-web's `/api/cortex/jobs/claim` endpoint, executes claimed jobs by calling back to the tenant's MCP server's `/api/mcp/tools/{kind}/invoke` (gateway-secret-authed, runs inline), reports results via `/api/cortex/jobs/complete`. Idle-exits after `PRZM_CORTEX_WORKER_IDLE_EXIT_MS` (default 60s) so Fly's `auto_stop_machines` can park the machine. See Pyre Business Plan doc 25.
- `deploy/workers/fly.toml` — autoscale-to-zero Fly app config for the worker fleet (`min_machines_running=0`, `auto_start_machines=true`, `auto_stop_machines=stop`, `shared-cpu-2x@2GB`).
- Required env on worker machines: `PYRE_WEB_URL`, `CORTEX_WORKER_SECRET`. Optional: `WORKER_ID`, `CORTEX_WORKER_POLL_MS`, `PRZM_CORTEX_WORKER_IDLE_EXIT_MS`.

### Changed
- **`ingest_repo` and `ingest_url` MCP tools default to `async: true`.** The MCP HTTP transport drops connections when sync ingest exceeds its timeout; reproducible OOM-and-disconnect on a 1GB Fly box during a 1k-chunk ingest. Async returns `{ jobId, queued: true }` immediately; caller polls `kb_job_status({ jobId })`. Pass `async: false` explicitly when you know the work is small and want it inline.
- **Per-process concurrency cap on background ingest.** `JobRegistry.enqueue(jobId, work)` now respects `CORTEX_MAX_CONCURRENT_JOBS` (default 1). Excess jobs sit at `status='queued'` until a slot opens. Stops the "fire 6 in parallel and OOM" footgun.
- Dockerfile: install `ca-certificates` alongside `git` in the runtime image. Without it, every `git clone` over HTTPS failed with `server certificate verification failed. CAfile: none`.
- Internal package deps in `packages/server` and `packages/memory-remote` use `workspace:*` instead of `^0.x`. Forces pnpm's topological build order so providers build before server.

### Added (earlier)
- Shared credentials file at `~/.pyre/credentials.json` — one login per machine signs the user into Cortex, Engram, and Persona. Cortex extends the existing engram/persona shape with an additive `cortex.tenants[]` section, forward-compatible with the multi-tenant login flow.
- One-time migration from the legacy `~/.config/cortex/credentials.json` location. Runs on first credentials read; idempotent.
- 23 vitest cases covering credential round-trip, env-var precedence, active-tenant fallback, partial logout, and all migration paths.
- **Multi-tenant CLI login**. `cortex login <pyre-web-url>` now uses the shared `/api/auth/device-code` endpoint (same as engram-mcp + persona-mcp) with `scopes: ["cortex:tenants", "cortex:invoke"]`. pyre-web mints a user-scoped session token, then the CLI calls `/api/cortex/tenants` to enumerate every Cortex deployment the user can reach via memberships. Pro users with one tenant get a single entry; enterprise users with multiple memberships get one row per tenant. All tenants land in `~/.pyre/credentials.json` under `cortex.tenants[]`; the first is set as active.
- **`cortex tenant` subcommands**:
  - `cortex tenant list` — show all tenants on this machine with the active one starred.
  - `cortex tenant switch <slug>` — change which tenant `cortex serve` proxies to. Pure file edit; no network call.
  - `cortex tenant refresh` — re-fetch the tenant list from pyre-web. Useful when an admin adds/removes the user without forcing a re-login.

### Changed
- `cortex login` now requires the pyre-web URL via positional arg, `--server` flag, or `PYRE_API_URL` env var. The previous `DEFAULT_LOGIN_SERVER = "https://getpyre.ai"` hardcode has been removed per the no-hardcoded-environment-URLs policy.
- `cortex logout` now removes only Cortex's section of the shared credentials file. Engram and Persona credentials are preserved.
- Auth code lives at `packages/server/src/auth/` (mirrors engram's layout) instead of `packages/server/src/cli/`.

### Removed
- `packages/server/src/cli/credentials.ts` and `packages/server/src/cli/login.ts` (replaced by the `auth/` modules).
- `CORTEX_LOGIN_SERVER` env var (no longer needed — `PYRE_API_URL` takes its place per the shared convention).

### Refactored
- **`packages/server/src/api/server.ts` split by URL prefix.** The 2,122-line god file is now a 349-line dispatcher that hands each request off to a focused route module under `packages/server/src/api/routes/`. 18 route files, one per URL prefix (widgets, workspaces, config, wizards, mcp-tools, modules, auth-github, admin-memory, admin-backup, types, logs, status, setup, layout, reload, adapters, workspace-files, workspace-docs) plus `health`. Devs see a 404 in production, grep the URL prefix, find the file. No behavior changes; all 319 tests still pass.
- Shared HTTP helpers extracted to `api/http.ts` (`sendJson`, `readJsonBody`, `setCors`); auth gating to `api/auth.ts`; hot-reload helper to `api/reload.ts`. Each route handler takes a `RouteContext` (defined in `api/route-context.ts`) so adding a new dependency to the request pipeline is a one-place change.
