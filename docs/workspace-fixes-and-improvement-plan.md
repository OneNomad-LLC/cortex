# Cortex — Workspace Fixes + EIP/Mastra-Informed Improvement Plan

_Date: 2026-05-27. Status: Part 1 shipped (uncommitted), Part 2 planned, Part 3 advisory._

This doc records (1) the workspace bugs already fixed, (2) the planned improvements drawn from a comparison against Elevate's EIP platform, and (3) what to borrow vs. avoid from the Mastra framework. It is the brief for the cortex improvement work.

---

## Part 1 — Workspace fixes (DONE, verified, not yet committed)

Two related bugs, one root cause: the **session→active-workspace fallback** lived in `resolveSessionWorkspaceSlug()` (`packages/server/src/session-workspace-helpers.ts:45`, used by scoped tools), but two surfaces read the raw session binding instead.

### Bug 1 — session→workspace binding didn't persist
New MCP sessions reported `workspace: null` and forced re-onboarding even when an active workspace existed on disk. `get_session_workspace` did `state?.workspace ?? null`, conflating "never picked" (`undefined`) with "explicitly none" (`null`).

**Fix** (`packages/server/src/mcp/tools/session-workspace.ts`) — chosen behavior: **Hybrid**.
- `get_session_workspace` still returns `workspace: null` when unbound (onboarding prompt preserved), but now distinguishes `undefined` from `null` and, on `undefined`, returns a new `suggestedWorkspace` = last-active workspace + guidance to offer a resume.
- `set_session_workspace` now writes the bound slug to the `state.json` active pointer (via `updateState`) so the suggestion tracks the most recent choice. Binding to `"none"` leaves the pointer untouched.

### Bug 2 — dashboard memories page ignored workspace
`dashboard-memories.ts` did `session.session.workspace ?? ""`, then `...(workspace ? { workspace } : {})`. An unbound dashboard session dropped the filter entirely and `engram.search` returned every workspace's memories.

**Fix** (`packages/server/src/api/routes/dashboard-memories.ts`) — when the session has no bound workspace, fall back to `getActiveWorkspace()` before querying. The pgvector backend already scopes by the resolved slug.

### Verification
`tsc --build` clean · biome lint clean · full server suite **466 passed / 1 skipped** · added `packages/server/tests/session-workspace-tool.test.ts` (6 tests).

---

## Part 2 — Improvement plan (informed by EIP)

EIP's edge over cortex is structural enforcement of isolation/governance. The lesson Bug 2 embodies: **enforce isolation in the substrate, not by convention.** Ranked items:

### #1 — Push workspace scoping into a SQL predicate — ALREADY SATISFIED
The live retrieval path already does this: `clients/pgvector.ts:139` passes `workspace` to the backend, and `packages/memory-pgvector/src/queries.ts:141-146` applies `(workspace = $slug OR workspace IS NULL)` as a column pre-filter inside each RRF CTE. The post-fetch, tag-based `filterByWorkspace` in `clients/engram.ts` is the **legacy engram-subprocess path**, not live. No work needed.
- Optional residual: the intentional `OR workspace IS NULL` legacy-visibility clause means unscoped/`default` rows appear in every workspace. Consider an opt-in strict mode to exclude nulls. Low priority, debatable (it would hide pre-session-scoping memories).

### #2 — Metadata-contract conformance test — SMALL
The metadata contract (`schemas/memory-metadata.json`, Zod-mirrored in `packages/core/src/metadata.ts`) is "load-bearing… breaking it silently breaks retrieval" per CLAUDE.md, yet nothing enforces it mechanically across ingest paths. Add a conformance test that validates representative adapter/ingest output (and/or a runtime guard at the ingest boundary) against the schema. EIP's discipline (contract → conformance suite) at ~1% of its cost.

### #3 — Honor the `trust` field in ranking — SMALL
`trust` (`approved | experimental | external`) exists in `packages/core/src/metadata.ts:80` but is never used. Down-rank or default-exclude `experimental`/`external` results, surfacing them only on request. Uses existing metadata; **no review queue** (that would violate cortex's "no constant manual curation" rule). EIP's draft→candidate→approved curation, right-sized.

### #4 — Sensitivity-aware retrieval — SMALL
`sensitivity` (`public → restricted`, `packages/core/src/metadata.ts:69`) is stamped but never filtered on. Now that the dashboard has admin scopes + GitHub login (drifting multi-user), let `kb_search`/dashboard carry a max-sensitivity and exclude higher-sensitivity rows. EIP's entitlement gating, right-sized.

### #5 — Postgres row-level security (external mode) — MEDIUM
The CTEs filter app-side; a forgotten filter (exactly Bug 2) can still leak. For **external Postgres mode**, add an RLS policy keyed on workspace + a session GUC (`SET app.workspace = …`) so the database refuses cross-workspace reads structurally. **Must not break embedded PGlite mode** (skip RLS there). This is the durable version of the Bug 2 fix and the central EIP lesson.

**Suggested order:** #2 → #4 → #3 (small, additive) → #5 (structural). #1 is done.

---

## Part 3 — Mastra: borrow, don't depend (advisory)

Cortex's hybrid RRF retrieval is **ahead** of Mastra's RAG (single-vector cosine + optional LLM rerank, no hybrid/RRF). Mastra's LLM-in-loop memory also clashes with cortex's zero-LLM-at-query-time ethos. So: borrow techniques, don't take a dependency.

**Worth borrowing (no coupling):**
- **Pluggable filter translator** — Mastra translates a generic Mongo-style `$and/$or/$eq` filter into backend SQL (`PGFilterTranslator`). Cleaner than cortex's ad-hoc `metadata->>'x'` predicates in `queries.ts`; makes the filter layer portable.
- **LLM ingest extractors** — Mastra's `KeywordExtractor`/`SummaryExtractor`/`QuestionsAnsweredExtractor` formalize ingest-time enrichment. Cortex's meeting pipeline already does this ad hoc; the pattern is a clean reusable shape.
- **xxhash content-addressed embedding cache** — skip re-embedding identical text within a process. Free win on re-ingest.

**Integration stance:** Mastra is a credible *consumer* of cortex (a Mastra agent can call cortex's MCP tools via `MCPClient` with zero new code), not a host cortex should depend on. If a native `MastraVector` adapter is ever built for distribution, it must live in a **separate optional package** (e.g. `@przm/cortex-mastra-vector`) — `@mastra/core` imports EE-licensed code at module load and ships hardcoded PostHog telemetry, neither of which belongs in cortex core. Not pre-launch.

**Do NOT adopt:** SpiceDB/ReBAC (workspace RLS is the right granularity), the Mastra runtime/Iron-Laws machinery (cortex is a data plane), or EIP's 249-contract apparatus (one conformance test — #2 — captures most of the value).
