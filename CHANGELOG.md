# Changelog

All notable changes to Cortex will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
