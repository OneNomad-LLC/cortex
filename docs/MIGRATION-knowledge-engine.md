# Cortex 0.3 — Knowledge Engine Repositioning

Status: **Phases 1A, 1C, 2, 4 shipped; Phases 0, 1B, 1D deferred.**
Updated: 2026-05-09 (post-execution).
Companion: `pyre/CHANGELOG.md`.

## Done today

| Phase | Cortex commit | Summary |
|-------|---------------|---------|
| 1A    | `9204e35`     | Removed gmail / google-calendar / google-drive / outlook adapters + google-login CLI. |
| 1C    | `990d3a7`     | Removed 10 personal-priority MCP tools (digest, action_items, summarize_*, session-handoff×3, add_person, *_user_identity). |
| 2     | `44a4de6`     | Added `ingest_url` + `ingest_repo` MCP tools (synchronous). |
| 2+    | `31cec7f`     | `ingest_url` BFS sitemap crawl with same-host + path-prefix scope. |
| 2+    | `a32e57d`     | `ingest_repo` accepts git URLs (shallow clone → walk → cleanup). |
| 4     | `0c8b7b6`     | Added `kb_search` + `kb_dossier` MCP tools (mirrors Engram pattern). |

Pyre-side commits that consume the new Cortex surface (in `pyre`):
- `83e454e` — refresh Cortex MCP catalog entry for 0.3 description.
- `df8bc79`, `451d2bf`, `dcfcdfb` — `~/.pyre/inbox` auto-ingest watcher (class + boot wiring + Settings toggle).
- `a121fa3` — Settings → Knowledge card with file/url/repo forms.

## Still deferred

- **Phase 0 (RLS)** — load-bearing security primitive. Schema design in this doc; implementation is a dedicated session.
- **Phase 1B (dashboard widget cascade strip)** — today-meetings / today-timeline / priorities / my-action-items / upcoming-briefs across server widgets + dashboard widgets + notification bootstrap. Estimated 4–6 hrs as a focused session.
- **Phase 1D (project-model flatten)** — collapse the per-project routing into one KB per tenant. ~100+ files touched. Dedicated session before the first enterprise contract.
- **Phase 2 deferred items still open**: PDF / DOCX / HTML binary-doc support in `ingest_file` (currently surfaces a clean "not yet supported" error so the missing capability is visible). Async job runner + `ingest_status` MCP tool.

The phase-by-phase plan below is preserved for future reference.

---



---

## TL;DR

Reposition Cortex from "Matt's personal work-knowledge tracker" into **the multi-tenant knowledge engine for Pyre**. Engram stays per-user memory; Cortex becomes per-tenant org knowledge. New raw ingestion surfaces (file / URL / repo). New retrieval surface for Pyre to consume over MCP.

This document is the **execution plan**. Each phase is sized, file-listed, and independently shippable. Do not skip Phase 0 if real customer data lands in Cortex — multi-tenant isolation is load-bearing.

---

## Architectural decision

**Engram** → per-user memory store. Lives in Pyre's repo (`packages/memory`), backed by LanceDB. Owned by the user.
**Cortex** → multi-tenant knowledge base. Separate repo + MCP server, backed by Postgres + pgvector. Owned by the org.

Pyre talks to Cortex over MCP. Pyre is per-user; Cortex is per-tenant. Mirroring multi-tenant content into a per-user store breaks the tenancy model — so Cortex always owns its store and Pyre queries it.

The `workspace` column already in `memory-pgvector` is the de-facto tenant primitive. **Do NOT rename `workspace` → `tenant` in the schema** — that's a 30+ file mechanical refactor with high break risk for zero functional gain. Use `workspace` as the tenant boundary going forward and treat the rename as a docs-only change.

---

## Phase order (dependency-derived)

The order in this document differs from the original session plan because the codebase forced a re-think:

```
Phase 1  →  Phase 0  →  Phase 2  →  Phase 3  →  Phase 4
 strip       RLS       raw ingest    Pyre wiring   retrieval
```

Phase 1 must run before Phase 0 because RLS keys on the tenant model, and Phase 1 IS the tenant model decision (collapse personal-flow surfaces, settle the per-tenant boundary). Phase 0 before any new ingestion adapters because RLS policies must exist before new write paths land — otherwise the new tools ship without isolation.

---

## Phase 1 — Strip personal-priority surface

**Estimated effort: 6–10 hours.** Larger than initially scoped because the dashboard, notification scheduler, and widget infra are all wired into personal-flow concepts. Treat this as a focused day, not a side task.

### Phase 1A — Adapters + auth (safe, ~1 hour)

Delete these adapter packages outright:
- `packages/adapter-gmail/`
- `packages/adapter-google-calendar/`
- `packages/adapter-google-drive/`
- `packages/adapter-outlook/`
- `packages/google-auth/` (no consumers after the four above are gone)

Update these registries to drop the imports + factory entries + wizard entries:
- `packages/server/src/registry/adapters.ts` — remove imports + `adapterFactories` entries
- `packages/server/src/cli/wizard-registry.ts` — remove imports + `WIZARDS[]` entries
- `packages/server/package.json` — remove `dependencies` entries
- `packages/server/tsconfig.json` — remove `references[]` entries

Delete these CLI entry points:
- `packages/server/src/cli/google-login.ts`
- Update `packages/server/src/cli/index.ts` — remove `runGoogleLogin` import, command case, and HELP entry

Remove Google references from:
- `packages/server/src/cli/doctor.ts` — drop `defaultTokenPath` / `readGoogleToken` import; remove `ADAPTER_PACKAGE_TO_SECRETS` entries for gmail / google-calendar / google-drive; delete the `GOOGLE_ID_TO_SCOPE` constant; delete check #6 ("Google token") and renumber #7→#6, #8→#7, #9→#8, #10→#9
- `packages/server/src/cli/module-commands.ts` — drop the Google import + `GOOGLE_MODULES` set + `GOOGLE_MODULES.has(moduleId)` check + the `ensureGoogleToken` function + `SCOPES_FOR_MODULE` constant

### Phase 1B — Personal-flow widgets + notifications (heavy, ~4–6 hours)

These are deeply wired and require a coordinated removal sweep. This is where the previous session attempt stopped.

**Server widgets to delete:**
- `packages/server/src/api/widgets/today-meetings.ts` (depends on google-auth)
- `packages/server/src/api/widgets/today-timeline.ts` (imports today-meetings)
- `packages/server/src/api/widgets/upcoming-briefs.ts`
- `packages/server/src/api/widgets/priorities.ts`
- `packages/server/src/api/widgets/my-action-items.ts`
- `packages/server/tests/today-meetings.test.ts`

**Updates required:**
- `packages/server/src/api/widgets/index.ts` — remove the widget imports and `WIDGET_CACHE_CONFIG` entries
- `packages/server/src/api/layout.ts` — remove the widgets from default presets (keep the placeholder fallback so legacy presets still render)
- `packages/server/src/notification-data.ts` — drop the personal-widget data feeds
- `packages/server/src/notification-bootstrap.ts` — drop the 8am/5pm daily fires; keep the notification scheduler infra for future ingest-job alerts
- `packages/pipeline-notification/src/scheduler.ts` — re-purpose for ingest-job notifications, not personal digests

**Dashboard widgets to delete:**
- `packages/dashboard/src/widgets/today-meetings.tsx`
- `packages/dashboard/src/widgets/today-timeline.tsx`
- `packages/dashboard/src/widgets/upcoming-briefs.tsx`
- `packages/dashboard/src/widgets/priorities.tsx`
- `packages/dashboard/src/widgets/my-action-items.tsx`
- `packages/dashboard/src/widgets/registry.tsx` — remove the entries

### Phase 1C — Personal MCP tools (~1–2 hours)

Delete these MCP tool files in `packages/server/src/mcp/tools/`:
- `digest.ts` — today's digest
- `pending-action-items.ts` — my action items
- `summarize-meeting.ts` — catch_me_up_on_meeting
- `summarize-recent.ts` — catch_me_up
- `read-session-handoffs.ts`, `leave-session-handoff.ts`, `resolve-session-handoff.ts` — personal session continuity
- `add-person.ts` — personal contact tracking
- `get-user-identity.ts`, `update-user-identity.ts` — personal user profile

Update `packages/server/src/mcp/tools/index.ts` to remove the imports and tool registrations.

### Phase 1D — Project model decision (deferred to a follow-up session)

The project model (project_id columns, project filters, project-context tools, taxonomy gaps) is wired through dozens of files and is **not** in scope for the initial strip. Document the deprecation in the `0.3` README and tackle it in a focused session before the first enterprise contract.

### Phase 1 acceptance criteria

- `pnpm -r typecheck` green across the workspace
- `pnpm -r test` green
- `cortex doctor` runs cleanly without referring to gmail / calendar / drive / outlook
- Dashboard renders without 404 on its default preset
- README clearly states "Cortex 0.3 — knowledge engine for Pyre. Personal-flow surfaces removed."

---

## Phase 0 — RLS-mirrored ACLs

**Estimated effort: 8–12 hours.** Foundational security primitive — half-done is worse than not done. Do not start until Phase 1 is fully merged.

### Schema additions

In `packages/memory-pgvector/src/schema.ts`, the bootstrap SQL needs three new tables alongside the existing chunks table:

```sql
-- Tenants (orgs). One row per customer.
CREATE TABLE IF NOT EXISTS cortex_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Principals (users). Authenticated by external IdP (SSO later); for now,
-- an email + opaque token id.
CREATE TABLE IF NOT EXISTS cortex_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Membership: which principals belong to which tenants. A principal can
-- belong to multiple tenants (consultant scenario); a tenant has many
-- principals.
CREATE TABLE IF NOT EXISTS cortex_principal_tenants (
  principal_id uuid NOT NULL REFERENCES cortex_principals(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES cortex_tenants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member', -- member | admin | owner
  PRIMARY KEY (principal_id, tenant_id)
);
```

Add a `tenant_id uuid` column to the existing chunks table (use `workspace` as the source of truth — first migration step backfills `tenant_id` from `workspace`):

```sql
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES cortex_tenants(id);
-- Backfill from workspace string. Each unique workspace value becomes a tenant.
-- Run in app code (not in DDL) because we need to insert into cortex_tenants too.
```

### Session principal binding

Every Postgres connection from the application must set the principal on session start:

```sql
SET LOCAL app.current_principal = '<uuid>';
```

In `packages/memory-pgvector/src/pool.ts`, wrap the existing pool's `query` so every query is preceded by a `SET LOCAL` from the request context. Use `pg`'s connection-level hook so the binding is per-connection, not per-query (perf).

The principal comes from the MCP transport. Define the binding contract:
- HTTP transport: `Authorization: Bearer <jwt>` → decode → principal_id in request context
- stdio transport: principal pinned at server start via `--principal=<uuid>` flag (single-tenant workstation use)

### RLS policies

Enable RLS on every content table:

```sql
ALTER TABLE ${chunks_table} ENABLE ROW LEVEL SECURITY;

-- SELECT: only chunks where the chunk's tenant_id matches a tenant the
-- current principal is a member of.
CREATE POLICY chunks_tenant_isolation_select
  ON ${chunks_table}
  FOR SELECT
  USING (
    tenant_id IN (
      SELECT tenant_id FROM cortex_principal_tenants
      WHERE principal_id = current_setting('app.current_principal')::uuid
    )
  );

-- INSERT: principal must be a member of the target tenant.
CREATE POLICY chunks_tenant_isolation_insert
  ON ${chunks_table}
  FOR INSERT
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM cortex_principal_tenants
      WHERE principal_id = current_setting('app.current_principal')::uuid
    )
  );

-- UPDATE / DELETE: same as INSERT.
CREATE POLICY chunks_tenant_isolation_update
  ON ${chunks_table}
  FOR UPDATE
  USING (
    tenant_id IN (
      SELECT tenant_id FROM cortex_principal_tenants
      WHERE principal_id = current_setting('app.current_principal')::uuid
    )
  );
```

### ACL sync hook

Every adapter's ingest path must stamp the new chunks with the right tenant_id. Add a required `tenant_id: uuid` parameter to:
- `packages/core/src/types.ts` — `AdapterContext` shape
- Every adapter's `init()` and ingest path
- The pipeline-core's chunk-write helper

Adapters that pull from external systems (Confluence, Notion, etc.) must mirror the upstream system's ACL into a sidecar table:

```sql
CREATE TABLE IF NOT EXISTS cortex_chunk_principal_grants (
  chunk_id uuid NOT NULL REFERENCES ${chunks_table}(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES cortex_principals(id) ON DELETE CASCADE,
  PRIMARY KEY (chunk_id, principal_id)
);
```

Then layer a per-principal grant policy over the tenant policy:

```sql
CREATE POLICY chunks_principal_grant_select
  ON ${chunks_table}
  FOR SELECT
  USING (
    id IN (
      SELECT chunk_id FROM cortex_chunk_principal_grants
      WHERE principal_id = current_setting('app.current_principal')::uuid
    )
  );
```

Postgres OR-combines policies — a principal can read a chunk if EITHER tenant membership matches OR they have an explicit grant. For "everyone in tenant can read" content (default), only the tenant policy fires; for restricted upstream ACLs, the grant table is mirrored on ingest.

### Phase 0 acceptance criteria

- New migration applies cleanly on a fresh database
- New migration applies cleanly on an existing 0.2 install (backfill works)
- A query from principal A to a chunk owned by tenant B (where A is not a member) returns zero rows — even with `bypass-rls` disabled
- An INSERT from principal A targeting tenant B (where A is not a member) raises "new row violates row-level security policy"
- Test coverage: at minimum 6 cases — same-tenant read, cross-tenant read (denied), grant-table override, INSERT cross-tenant denied, UPDATE cross-tenant denied, DELETE cross-tenant denied
- `cortex doctor --connect` reports tenant + principal counts

---

## Phase 2 — Raw ingestion adapters + MCP tools

**Estimated effort: 4–6 hours.** Builds on Phase 0's `tenant_id` plumbing.

### New adapter packages

Three new packages under `packages/`:

- `adapter-file/` — accepts PDF / markdown / txt / docx / html paths. Wraps existing `pipeline-doc`.
- `adapter-url/` — single-page fetch + sitemap crawl. Wraps existing `pipeline-research` (2-pass).
- `adapter-repo/` — clone (or use local path) → walk → chunk by file type. Wraps existing `pipeline-code`.

Each follows the existing adapter SDK pattern (configSchema, requiredSecrets, init, sync). Register them in `packages/server/src/registry/adapters.ts`, `packages/server/src/cli/wizard-registry.ts`, `packages/server/package.json`, `packages/server/tsconfig.json`.

### New MCP tools

In `packages/server/src/mcp/tools/`:

- `ingest-file.ts` — already exists; extend to accept tenant_id + tags
- `ingest-url.ts` — new; single page or sitemap (depth-bounded)
- `ingest-repo.ts` — new; URL + branch OR local path
- `ingest-status.ts` — new; query job state by jobId

All return `{ jobId, queued: true }`. Cortex's existing pipeline runner handles async processing; status surfaced via `ingest_status({ jobId })`.

### Background job runner

The pipeline-core probably already has a job queue. If not, add a lightweight one in `packages/server/src/jobs/queue.ts`:
- In-process queue (Postgres-backed for durability across restarts)
- Worker pool sized to `min(cpus, 4)`
- Per-job log lines persisted to `cortex_ingest_jobs` table
- 24h retention on completed jobs

### Phase 2 acceptance criteria

- `cortex add file` / `cortex add url` / `cortex add repo` wizards work
- `ingest_file` MCP tool ingests a 10-page PDF and a 5K-line repo without OOM
- Sitemap crawl honors a configurable max-pages cap (default 100)
- Repo ingest skips `node_modules`, `.git`, `dist`, `build`, etc. by default
- Status tool returns useful state: queued / running (% complete) / completed (chunks written) / failed (error string)

---

## Phase 3 — Wire Cortex into Pyre

**Estimated effort: 4–6 hours.** Touches Pyre's MCP registry, Settings UI, IPC handlers, tool registry, and a new background watcher.

### Pyre-side changes

In `pyre/`:

**MCP preset** — add Cortex to `pyre/packages/core/src/mcp-presets.json` (or wherever the curated MCP server list lives). Default off; user enables in Settings.

**Settings UI** — new "Knowledge" card in `pyre/apps/web/src/public/index.html` next to the Cognitive Stack card:
- File-drop zone (calls `pyre:cortex:ingest:file` IPC)
- URL paste field with crawl-depth selector (calls `pyre:cortex:ingest:url`)
- Repo URL paste field with branch selector (calls `pyre:cortex:ingest:repo`)
- Job-status poller (lists in-flight ingest jobs, % complete)

**IPC handlers** — new file `pyre/apps/desktop/src/ipc/cortex.ts`:
- `pyre:cortex:available` — returns whether Cortex is configured
- `pyre:cortex:ingest:file` — proxies to Cortex MCP `ingest_file`
- `pyre:cortex:ingest:url` — proxies to Cortex MCP `ingest_url`
- `pyre:cortex:ingest:repo` — proxies to Cortex MCP `ingest_repo`
- `pyre:cortex:ingest:status` — proxies to Cortex MCP `ingest_status`

**Chat tools** — register `ingest_doc`, `ingest_url`, `ingest_repo` in Pyre's tool registry as proxies to the corresponding Cortex MCP tools. Gate registration on `cortex_available()` so Pyre still works without Cortex.

**Watch directory** — new background job in `pyre/apps/desktop/src/embedded/inbox-watcher.ts`:
- Watches `~/.pyre/inbox` (configurable in Settings)
- Debounced 2s after file write to allow large files to finish
- Calls `cortex.ingest_file({ path, tenant_id })` for each new file
- Moves processed files to `~/.pyre/inbox/.processed/<date>/<filename>`
- Failed files go to `~/.pyre/inbox/.failed/` with a sibling `.error` file

### Phase 3 acceptance criteria

- Boot Pyre with Cortex configured → Knowledge card shows "Connected" green
- Drop a PDF in the Knowledge card → ingest job appears, completes, chunks land in Cortex
- Agent calls `ingest_url` mid-task → Cortex receives the URL, returns jobId
- Drop a file in `~/.pyre/inbox` → file gets ingested + moved to `.processed`
- Boot Pyre WITHOUT Cortex configured → no errors; ingest tools simply not registered

---

## Phase 4 — Retrieval surface

**Estimated effort: 2–3 hours.** Mostly renaming + light wrapping of existing capabilities.

### Cortex-side new MCP tools

In `packages/server/src/mcp/tools/`:

- `kb-search.ts` — wraps existing `search-related`. Signature: `{ query, topK?, filters? }` → ranked chunks with `tenant_id`-filtered results (RLS handles isolation transparently).
- `kb-dossier.ts` — entity-shaped pre-load. Signature: `{ entity, type? }` → canonical JSON for the entity (project, person, codebase) PLUS top relevant chunks. Mirrors the Engram `memory_dossier` pattern from the local-context roadmap, but at the org-knowledge level.

Both register in `packages/server/src/mcp/tools/index.ts`.

### Pyre-side coordinator wiring

Pyre's coordinator + agents call `kb_search` alongside `memory_search`. Two cognitive layers:
- `memory_search` (Engram, per-user) — "what does the user know about X"
- `kb_search` (Cortex, per-tenant) — "what does the org know about X"

Compose them in `pyre/packages/engine/src/engine.ts` per-turn:
- For factual / lookup categories → run both in parallel
- For personal / conversational → memory_search only
- For code / project-specific → kb_search dominant, memory_search for user prefs

### Phase 4 acceptance criteria

- `kb_search({query: "..."})` returns chunks scoped to the current principal's tenant
- `kb_dossier({entity: "Maaco Digital Signage SOW"})` returns canonical project JSON + top chunks
- Pyre's chat surface uses both memory_search + kb_search and labels source clearly in the system prompt
- Cross-tenant query returns zero results (RLS verification)

---

## Effort summary

| Phase | Hours | Risk | Independently shippable |
|-------|-------|------|------------------------|
| 1A — adapter strip | 1 | low | yes |
| 1B — widget strip | 4–6 | medium | no (must finish before 1C) |
| 1C — MCP tool strip | 1–2 | low | yes (after 1B) |
| 1D — project model | deferred | high | no |
| 0 — RLS | 8–12 | high (security) | yes |
| 2 — raw ingest | 4–6 | medium | yes |
| 3 — Pyre wiring | 4–6 | medium | yes |
| 4 — retrieval | 2–3 | low | yes |
| **Total** | **24–37** | | |

This is **3–5 focused sessions of work**, not one. The original "all in one go" attempt hit the 0.2 codebase reality (dashboard widgets + notifications + deeply-wired personal-flow surfaces) and stopped. This document is the migration path that comes back from that.

---

## Recommended session order

1. **Session 1**: Phase 1A + 1C (low-risk strips) → ship 0.2.1
2. **Session 2**: Phase 1B (heavy widget strip) → ship 0.2.2
3. **Session 3**: Phase 0 (RLS) → ship 0.3.0-rc1
4. **Session 4**: Phase 2 + 4 (raw ingest + retrieval) → ship 0.3.0-rc2
5. **Session 5**: Phase 3 (Pyre wiring) — touches Pyre repo, not Cortex → ship Pyre alongside Cortex 0.3

Phase 1D (project-model flatten) gets its own dedicated session before the first enterprise contract — it's a multi-day refactor on its own and shouldn't block any of the above.

---

## Open questions

- **Auth provider**: SSO targets for Phase 0 — Auth0, Clerk, Workos, or roll-your-own JWT? Pyre Enterprise positioning implies SAML/OIDC; defer concrete pick to Phase 0 design.
- **Tenant provisioning UX**: who creates a tenant? CLI command? Self-serve dashboard signup? First-user-becomes-owner pattern? Phase 0 needs this answered.
- **Engram ↔ Cortex coordination**: when a Pyre user joins multiple Cortex tenants, does each tenant get its own Pyre profile? Or one Pyre profile that switches tenant context per query? Probably the latter, but spec out before Phase 3.
- **Migration story for existing 0.2 installs**: Matt's own data is in the current `workspace`-shaped schema. Phase 0's tenant backfill needs to handle this cleanly — probably one tenant per existing workspace string, with Matt as owner of all of them.
