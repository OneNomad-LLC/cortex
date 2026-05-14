# Plan: Split `packages/server` into cli / server / mcp-tools

**Status:** planning — not yet executed
**Cortex repo task:** #5
**Estimated scope:** 2-3 days, multiple PRs

## Why split

`packages/server` today is a god package: 19 CLI commands (~8,650 LOC), 30 MCP tools, the HTTP API server (1,920-line `api/server.ts`), cron, scheduler, sync, webhooks, hot-reload, enrichment, taxonomy, registry, dashboard-child management, log-bus, heartbeat, notes — all in one npm package.

Three audiences. Three packages.

| Audience | Wants | Today | After split |
|---|---|---|---|
| Local-install user | Small CLI to `cortex login`, `cortex init`, `cortex serve` | Pulls all 25 cortex-* workspace deps | `@onenomad/cortex-cli` only |
| Hosted/Fly tenant | Long-running server with MCP + API | Same package as the CLI | `@onenomad/cortex-server` only |
| MCP tool author | Reusable tool definitions | Tools live inside the server package | `@onenomad/cortex-mcp-tools` |

## Dependency reality (post-analysis 2026-05-14)

Mapped imports show a one-way fan-out, not a clean three-way split:

```
cli/* ─────► (config, logger, registry, clients, sync, taxonomy, ...)
                    │
                    ▼
mcp/server.ts ────► (config, logger, registry, clients, scheduler, sync, ...)
                    ▲
                    │
api/server.ts ──────┘

mcp/tools/* ─────► (mostly self-contained — zero `../` imports outside `tools/`)
```

So:
- **`mcp/tools/`** is genuinely separable today. No cross-cutting imports outside its own subdir.
- **`cli/`** depends heavily on top-level modules (`config`, `logger`, `clients`, `registry`, `taxonomy`, `sync`, etc.) that the runtime server also uses.
- **`mcp/server.ts`** + **`api/server.ts`** import from those same top-level modules AND from `cli/` (via `cli/seed-self`, `cli/config-mutation`, `cli/config-path`).

This means the "shared infrastructure" (config, logger, clients, registry, taxonomy, scheduler, sync, webhooks, etc.) is the actual core that both CLI and server depend on. A clean three-way split needs a fourth piece: a "core" library.

## Revised target: 4 packages, not 3

```
@onenomad/cortex-mcp-tools     ← The 30 MCP tool definitions (pure functions)
@onenomad/cortex-runtime       ← Shared infra: config, logger, clients,
                                 registry, taxonomy, sync, scheduler,
                                 webhooks, enrichment, heartbeat, etc.
@onenomad/cortex-server        ← MCP HTTP transport + dashboard API + cron
                                 + hot-reload (depends on -runtime + -mcp-tools)
@onenomad/cortex-cli           ← All 19 CLI commands + wizards
                                 (depends on -runtime + -server for `serve`)
```

Top-level `@onenomad/cortex` becomes a meta-package that re-exports cli for back-compat, with a deprecation note pointing at the new packages.

## Execution order

Each step is its own PR. Smaller PRs = easier review + safer rollback.

### Phase 1: Extract `@onenomad/cortex-mcp-tools` (lowest risk)
- Create `packages/mcp-tools/` with `package.json`, `tsconfig.json`, `eslint.config.mjs`
- Move `packages/server/src/mcp/tools/*` to `packages/mcp-tools/src/`
- Move `packages/server/src/mcp/tool.ts` (the tool-shape + ToolContext type)
- Add `@onenomad/cortex-mcp-tools` as a `workspace:*` dep of `@onenomad/cortex`
- Update mcp/server.ts to import from the new package
- Verify all tests pass + Docker image builds

### Phase 2: Extract `@onenomad/cortex-runtime`
- Create `packages/runtime/` package
- Move shared infra modules: `config.ts`, `logger.ts`, `clients/`, `registry/`, `taxonomy*.ts`, `sync.ts`, `scheduler.ts`, `cron.ts`, `webhooks.ts`, `enrichment.ts`, `heartbeat.ts`, `streams.ts`, `session-context.ts`, `session-workspace-helpers.ts`, `private-modules.ts`, `taxonomy-cache.ts`, `notes/`, `log-bus.ts`, `hot-reload.ts`
- Add as `workspace:*` dep of `@onenomad/cortex`
- Update all imports across the existing server package

### Phase 3: Extract `@onenomad/cortex-cli`
- Create `packages/cli/` package
- Move `packages/server/src/cli/*` to `packages/cli/src/`
- Add bin: `cortex` → dist/index.js
- Add deps: `@onenomad/cortex-runtime`, `@onenomad/cortex-server`
- Update `claude mcp add` instructions in docs to reference the new package install command

### Phase 4: Rename remaining `@onenomad/cortex` to `@onenomad/cortex-server`
- The old `packages/server/` becomes the actual server (MCP + API + dashboard-child)
- Or: keep `@onenomad/cortex` as the published name for back-compat, but make it just the server
- Decide based on whether existing installs break

### Phase 5: API split (task #6)
- `packages/server/src/api/server.ts` (1,920 lines) splits by resource into `api/routes/widgets.ts`, `api/routes/modules.ts`, `api/routes/workspaces.ts`, `api/routes/auth.ts`, etc.
- `api/server.ts` becomes a thin wiring file

## Risks + mitigations

1. **Build/Docker breakage.** Each phase commit must keep `pnpm -r build` and `docker build .` green. CI on every PR catches this.
2. **Existing `claude mcp add cortex cortex -- serve` breaks.** If `cortex` is no longer installable as a single npm install, users get cryptic errors. Mitigation: keep `@onenomad/cortex` as a meta-package that depends on `-cli`, so `npm install -g @onenomad/cortex` still works.
3. **Per-tenant Fly Machines** use the published image, not npm packages. They need `pnpm install` of all four packages. Dockerfile changes per phase.
4. **TypeScript project references** need updating per phase. `tsconfig.json` `references` arrays in dependent packages must be added.
5. **Pre-existing tech debt** (pre-existing lint warnings, the `@onenomad/cortex-core` exports drift) shouldn't block this work — fix in separate PRs.

## What should NOT happen as part of this work

- Server code refactor beyond what's needed to move modules between packages
- Behavior changes to MCP tools or HTTP API
- Dashboard-related changes (those are tasks #2-#4, gated on pyre-web)
- Migration to a new test runner or build tool

## Decision needed before starting

The four-package shape is the recommended landing — but it's larger than the original "split into three" task. Need explicit go-ahead because:

- ~3 days of work
- 5 PRs (one per phase)
- Affects every consumer of the cortex npm package
- Likely needs a coordinated `@onenomad/cortex` version bump (0.4 → 0.5)

Alternative: do **Phase 1 only** (extract mcp-tools), defer Phases 2-5 until there's a concrete consumer for the runtime/cli split. Lower scope, lower payoff, but proves the pattern.
