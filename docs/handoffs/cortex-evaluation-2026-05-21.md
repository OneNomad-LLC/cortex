# Handoff: cortex-evaluation-2026-05-21

> **Persistence note:** This file is a fallback. The strategist agent ran in a harness without `memory-handoff-write` / `memory-ingest` MCP tools available (przm-memory MCP server never exposed its schemas to ToolSearch). Ingest this file into przm-memory from a working session to complete the handoff.
>
> Suggested ingestion:
> - `memory-handoff-write` with `name: cortex-evaluation-2026-05-21` and the structured fields below
> - `memory-ingest` of the Decision block under `domain: przm-suite`, `topic: cortex-vs-przm-memory`, `type: decision`, `importance: 0.85`

## currentTask
Produce a one-page recommendation on whether `cortex` should be kept separate from `przm-memory`, merged either direction, refactored to a shared core, or otherwise restructured — given that the user wants `przm-*` brand cohesion, no paying users exist on cortex yet, and code duplication between the two repos is real and growing.

## completed
- Read task summary off team-lead briefing (tasks #1 and #2 inventories trusted, not re-done).
- Verified key claims against the actual code:
  - `cortex/packages/memory-pgvector/src/embedder.ts:39` uses `Xenova/all-MiniLM-L6-v2` (384-dim).
  - `przm-memory/src/server.ts:668` uses the same model.
  - Cortex implements RRF in SQL at `cortex/packages/memory-pgvector/src/queries.ts:94-108`.
  - przm-memory implements RRF in TypeScript at `przm-memory/src/search.ts:214-250`.
  - Both ship a pgvector Postgres backend; przm-memory additionally ships a LanceDB file backend (`storage-adapter.ts`).
  - Cortex has zero runtime dependency on `@onenomad/przm-memory` or `@onenomad/engram-memory` (single comment reference in `clients/memory.ts:15` is documentation, not import).
  - `cortex/packages/memory-pgvector/src/embedder.ts:19-21` explicitly states "Engram is intentionally NOT a runtime dep here."
- Wrote and delivered the recommendation inline in chat.

## Decision (recommendation)
**Option D — Shared `@onenomad/przm-core` + two products.** Cortex renamed to `przm-corpus` (preferred over `przm-cortex` because "corpus" = body-of-knowledge, fits the org-KB framing better than "cortex" = single brain). `przm-memory` keeps its current shape.

### Top 3 reasons
1. **Duplication is verifiable and drifting.** Identical embedder model and dim; two RRF implementations (SQL vs TS) with already-divergent `k` defaults and bonus normalization; two pgvector backends (~700 LOC each); two source-dedup paths.
2. **Product shapes must stay distinct.** przm-memory: local-first, single-binary `npx`, LanceDB-default, stdio-MCP, per-user `~/.claude/engram`. Cortex: multi-tenant workspaces, adapter ecosystem, scheduler, HTTP-deployable. Folding either direction destroys distribution for the other.
3. **The refactor window is now.** No paying cortex users (per MIGRATION.md), 0.2 already broke back-compat, brand rebrand happening now. Three independent reasons to absorb a one-time refactor cost in the same quarter — this alignment will not recur.

### Strongest counter-argument
A solo dev with a day job ships faster with two grep-able repos than one factored repo with abstraction tax. The duplication is only ~2k LOC and changes rarely.

### Mitigation
Don't extract everything. Lift only what has already drifted or will: embedder, chunker, RRF math, source-dedup hashing. Leave KG / governance / diary / recall-outcomes in przm-memory and adapters / workspaces / scheduler in cortex. Keep `przm-core` <1.5k LOC and append-only. SemVer the core strictly; both consumers float minor versions independently. 3-month review: if `przm-core` has only patch releases, the bet is paying off; if it's churning, fold back. Cheap rollback.

## nextSteps
1. Create `@onenomad/przm-core` as its own repo (not nested under either product). First commit: port-as-is from `przm-memory/src/storage-adapter.ts` and `cortex/packages/memory-pgvector/src/{embedder,queries,schema}.ts`. No new abstractions until both products still pass tests against the port.
2. Convert `cortex/packages/memory-pgvector` and `przm-memory/src/storage-postgres.ts` to thin re-exporters of `przm-core`'s pgvector backend. Delete duplicate embedder in cortex; delete duplicate RRF in przm-memory.
3. Rename `cortex` repo + root package to `przm-corpus` (recommended) or `przm-cortex` (fallback). Update all `@onenomad/przm-cortex-*` workspace package names to `@onenomad/przm-corpus-*`. Ship a `cortex` shim package that re-exports with a deprecation warning for one release. Update `docker-compose.yml`, `bin` entries, MCP server name.
4. Write ADR-020 in `cortex/docs/DECISIONS.md` recording the rename + `przm-core` extraction.

## openQuestions
- Does the user prefer `przm-corpus` (my pick) or `przm-cortex` (mentioned in the original brief)?
- Should `przm-core` be a single repo with multiple packages, or a single package? Lean: single package to start; split when it actually has internal cohesion boundaries.
- Is `przm-voice` (formerly Persona) still consumed by cortex via MCP, or has cortex dropped that too? Affects the CLAUDE.md diagram update.
- What is the deprecation timeline for the `cortex` package name shim — one minor release, one major, until 1.0?

## fileRefs
- `/home/matt/development/cortex/packages/memory-pgvector/src/embedder.ts:39` — cortex embedder model
- `/home/matt/development/cortex/packages/memory-pgvector/src/embedder.ts:19-21` — explicit "Engram is not a runtime dep" comment
- `/home/matt/development/cortex/packages/memory-pgvector/src/queries.ts:94-108` — cortex RRF in SQL
- `/home/matt/development/cortex/packages/memory-pgvector/src/backend.ts:26-31` — PgPoolLike abstraction shim
- `/home/matt/development/przm-memory/src/server.ts:668` — przm-memory embedder model
- `/home/matt/development/przm-memory/src/search.ts:214-250` — przm-memory RRF in TS
- `/home/matt/development/przm-memory/src/storage-adapter.ts:30` — StorageAdapter interface (~the right contract for `przm-core`)
- `/home/matt/development/przm-memory/src/storage-postgres.ts` — przm-memory's pgvector backend (~700 LOC)
- `/home/matt/development/cortex/CLAUDE.md` — contains stale Engram-as-MCP-dependency framing, needs rewrite
- `/home/matt/development/cortex/docs/DECISIONS.md` — needs new ADR-020

## decisions
- Recommend Option D (shared core + two products) over A/B/C.
- Recommend rename to `przm-corpus` over `przm-cortex`.
- Extract scope = embedder + chunker + RRF + source-dedup + storage adapter. KG, governance, diary, recall-outcomes stay in przm-memory. Adapters, workspaces, scheduler, enrichment protocol stay in cortex.
- Hard cap on `przm-core` size: <1.5k LOC, append-only API for v0.x.

## notes
- Cortex docs are materially false post-ADR-012 regardless of structural call. These need updating either way:
  - `cortex/CLAUDE.md` line ~3-10: "Built as an orchestration layer on top of Engram (memory) and Persona (communication style)" — false for memory.
  - `cortex/CLAUDE.md` "What This Project Is NOT" — "Not a fork of Engram… Those are consumed as MCP services" — false for memory.
  - `cortex/CLAUDE.md` ASCII architecture diagram still shows `Engram MCP` + `Persona MCP` as siblings — replace with `memory-pgvector` in-process and (if still used) `przm-voice MCP`.
  - `cortex/CLAUDE.md` Tech Stack: split memory (in-process) vs voice (MCP).
  - `cortex/README.md` — audit for same Engram-as-dependency framing.
  - `cortex/AGENTS.md` — any "call Engram for storage" instructions are obsolete; point at `packages/server/src/clients/memory.ts`.

- Harness limitation flagged to team-lead: this agent ran without przm-memory/przm-voice/gemini-cli/vscode/Figma MCP tools loaded. ToolSearch returned no matches for any deferred tool. Recommendation: investigate why MCP servers listed as "connecting" never exposed schemas in this team-spawned session. If it's a systemic issue, subagents are running blind to the standing instruction to use przm-memory.
