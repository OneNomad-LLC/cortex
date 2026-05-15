# Changelog

All notable changes to Cortex will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **`cortex worker` subcommand** — long-running entrypoint for the cortex-workers Fly fleet. Polls pyre-web's `/api/cortex/jobs/claim` endpoint, executes claimed jobs by calling back to the tenant's MCP server's `/api/mcp/tools/{kind}/invoke` (gateway-secret-authed, runs inline), reports results via `/api/cortex/jobs/complete`. Idle-exits after `CORTEX_WORKER_IDLE_EXIT_MS` (default 60s) so Fly's `auto_stop_machines` can park the machine. See Pyre Business Plan doc 25.
- `deploy/workers/fly.toml` — autoscale-to-zero Fly app config for the worker fleet (`min_machines_running=0`, `auto_start_machines=true`, `auto_stop_machines=stop`, `shared-cpu-2x@2GB`).
- Required env on worker machines: `PYRE_WEB_URL`, `CORTEX_WORKER_SECRET`. Optional: `WORKER_ID`, `CORTEX_WORKER_POLL_MS`, `CORTEX_WORKER_IDLE_EXIT_MS`.

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
