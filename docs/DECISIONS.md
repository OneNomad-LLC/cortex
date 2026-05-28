# Architectural Decisions

ADR-style log. Each decision is short: context, decision, consequences.
Reversing a decision is fine — add a new entry, don't edit old ones.

Format:

```
## ADR-NNN: Title (YYYY-MM-DD)

**Status**: Accepted | Superseded by ADR-MMM | Deprecated

**Context**: Why this came up.

**Decision**: What we chose.

**Consequences**: What follows from this. Good and bad.
```

---

## ADR-001: Compose Engram and Persona, do not merge (2026-04-21)

**Status**: Accepted

**Context**: Engram and Persona are existing public MCP servers authored by
the same developer. Cortex needs memory (Engram's job) and communication-style
awareness (Persona's job). Options: fork/merge them into Cortex, or consume
them as MCP services.

**Decision**: Consume both as MCP services. No code imports. Network boundary
only.

**Consequences**:
- Upstream projects stay clean public releases; Cortex upgrades in sync.
- License clarity: Cortex (private, potentially commercial) never imports
  BSL-licensed Engram code.
- Testability: each service tested in isolation; integration tests via Docker.
- Small runtime overhead from MCP calls; negligible at expected scale.
- Forces clean domain boundaries, which protects all three projects long-term.

## ADR-002: Propose `reference` cognitive layer upstream to Engram (2026-04-21)

**Status**: Proposed (implementation pending)

**Context**: Engram's cognitive layers (episodic, semantic, procedural) all
decay over time. Cortex ingests reference material (Confluence docs, code,
architectural decisions) that should persist without decay.

**Decision**: Propose a new `reference` cognitive layer to Engram with
near-zero decay and promotion rules matching reference material behavior.
Do NOT add this layer in Cortex's private layer or via a fork.

**Consequences**:
- Engram benefits from a genuinely useful new layer.
- Cortex's work depends on an Engram upstream change; track dependency.
- If the proposal stalls, fall back to `semantic` with tuned decay parameters
  (inferior but workable).

## ADR-003: TypeScript, matching Engram and Persona (2026-04-21)

**Status**: Accepted

**Context**: Cortex could be any language. Engram and Persona are TypeScript.

**Decision**: TypeScript.

**Consequences**:
- Shared tooling, types, and idioms across the three projects.
- Easy for contributors (if any) to move between them.
- Downside: weaker fit for some data processing tasks than Python, but
  acceptable for our scale.

## ADR-004: Local LLM (Windows Ollama) as primary, OpenRouter as fallback (2026-04-21)

**Status**: Accepted (updated with hardware specifics)

**Context**: Pipeline LLM calls have real cost if cloud-only. Author's Windows
desktop has an AMD 9070 XT with 16GB VRAM, capable of running Qwen 3 14B at
good speed via Vulkan/ROCm. Desktop is more reliable than the Mac laptop for
always-on services. Claude Max handles interactive use; pipeline needs
separate inference.

**Decision**: Windows Ollama running Qwen 3 14B as primary for all pipeline
steps. Mac Ollama (Qwen 3 30B when available) as secondary fallback.
OpenRouter (Haiku 4.5 or Gemini Flash Lite) as final fallback and for
synthesis-quality-critical passes. Configurable per-step.

**Consequences**:
- Near-zero ongoing cost when the Windows desktop is available (which it
  mostly is).
- Privacy: company data stays local by default.
- Slower inference than cloud APIs on 14B, but acceptable for async pipeline.
- Multi-machine resilience: three tiers means pipeline never fully blocks.
- 14B quality is noticeably below 30B for synthesis; mitigate by routing
  pass 2 (synthesis) through OpenRouter where quality matters most.

## ADR-005: Single-host deployment over Tailscale (2026-04-21)

**Status**: Accepted

**Context**: Author uses multiple machines. Data should have one source of
truth.

**Decision**: Run Cortex, Engram, and Persona on a single host (Hetzner
CCX13). AI clients on any machine connect to the remote MCPs over Tailscale
for auth and encryption. Public exposure of MCP endpoints avoided.

**Consequences**:
- One data store, no sync issues.
- Tailscale dependency (negligible, free tier works).
- Host outage = all MCP down; backups and quick-restore procedure mandatory.

## ADR-006: Project taxonomy as versioned YAML in repo (2026-04-21)

**Status**: Accepted

**Context**: Project definitions need to be authoritative and trackable.
Options: in Engram as memories, in a database, in config files.

**Decision**: `config/projects.yaml` and `config/people.yaml` in the Cortex
repo. Versioned, reviewable, diffable. Loaded at startup; changes require
restart.

**Consequences**:
- Git history = taxonomy evolution.
- Easy to hand-edit.
- Changes require a restart (acceptable; taxonomy changes are infrequent).
- Rename aliases supported in YAML to avoid breaking existing memories.

## ADR-007: Prompts live as markdown files, not code strings (2026-04-21)

**Status**: Accepted

**Context**: Pipeline quality depends heavily on prompt quality. Prompts
embedded in code are painful to review and iterate on.

**Decision**: All prompts live in `packages/pipeline-*/src/prompts/` as `.md`
files. Code loads them at runtime. One file per prompt.

**Consequences**:
- Prompts are diffable and reviewable.
- Non-technical iteration possible (edit the prompt file, reload).
- Tests can use fixture prompts separately from production prompts.

## ADR-008: Modular adapter architecture with monorepo workspaces (2026-04-21)

**Status**: Accepted

**Context**: Cortex needs to ingest from many sources: Loom, Confluence,
Bitbucket, Obsidian today; potentially Slack, email, Notion, Google Meet,
Figma, and others later. The author also wants the ability to disable sources
they don't currently need. If adapters are scattered through the Cortex
codebase, adding or removing sources becomes structurally expensive.

**Decision**: Every source is a standalone package in an npm workspace
monorepo. Adapters implement a shared `SourceAdapter` interface from
`@onenomad/przm-cortex-core`. The Cortex server has a registry that loads enabled adapters
at startup based on `config/cortex.yaml`. Pipelines (meeting extraction, doc
chunking, code indexing) are also modular packages that adapters declare
they use.

Package layout:
- `@onenomad/przm-cortex-core` — shared types, interfaces, context
- `@onenomad/przm-cortex-adapter-sdk` — base classes, retry, rate-limit, idempotency,
  default classifiers
- `@onenomad/przm-cortex-pipeline-core` — generic pipeline framework
- `@onenomad/przm-cortex-pipeline-*` — specific pipelines (meeting, doc, code, ...)
- `@onenomad/przm-cortex-adapter-*` — specific adapters (loom, confluence, obsidian, ...)
- `@onenomad/przm-cortex-server` — MCP server, registry, scheduler, clients

**Consequences**:
- New adapters are contained projects, not structural changes. A well-scoped
  new source is roughly a day of work.
- Adapters own their own dependencies (Loom SDK, Atlassian SDK, etc.). No
  dependency bloat in the core.
- Toggle adapters on/off via config. Remove entirely by uninstalling the
  package.
- TypeScript catches interface mismatches at compile time. Runtime registry
  catches config/credential issues at startup.
- Monorepo tooling adds some complexity (pnpm or npm workspaces, turbo or
  nx optionally) but pays back fast.
- Static imports via workspace resolution, not dynamic `require()`. Trade-off:
  harder for third parties to write plugins, but Cortex isn't a plugin
  platform — it's the author's system. Third-party extensibility not
  needed in v1.
- Pipelines being separate packages means new adapters can reuse existing
  pipelines (a Google Meet adapter uses pipeline-meeting; a Notion adapter
  uses pipeline-doc). Avoids duplicated extraction logic.
- Future refactor risk: if an adapter needs capabilities the base interface
  doesn't support, we extend the interface. Adapters are versioned so
  breaking changes can be managed.

## ADR-009: Static workspace imports for adapters, not dynamic plugin loading (2026-04-21)

**Status**: Accepted

**Context**: Modular adapter architecture (ADR-008) raises the question of
how the server discovers and loads adapters. Two options: dynamic loading
from a plugins directory (e.g., `require()` at runtime), or static imports
resolved by the workspace with a config-driven enable/disable.

**Decision**: Static imports. The server package imports every adapter
package it knows about. `config/cortex.yaml` determines which are actually
instantiated and scheduled. Disabled adapters are imported but not run.

**Consequences**:
- TypeScript type-checks all adapters against the shared interface.
- Bundling and deployment are straightforward.
- Dependency versions are explicit and auditable.
- Testing is easier (adapters can be imported directly in tests).
- Adding a new adapter requires a one-line change in the server's adapter
  list plus the config entry. Not truly "install and go," but fine for a
  personal project.
- Third-party plugin support would require a future migration to dynamic
  loading. Not a current goal.

## ADR-010: Pluggable LLM provider layer with per-task routing (2026-04-21)

**Status**: Accepted

**Context**: ADR-004 fixed Windows Ollama as primary and OpenRouter as fallback.
That's the right default for this author, but baking it into the code makes
Cortex less useful for:
- Users who don't run Ollama locally
- Users with an existing Anthropic/OpenAI/Gemini key they'd rather bring
- Future experiments where a specific pipeline pass benefits from a specific
  model (e.g., longer context, vision, tool use)
- Testing, where swapping a real provider for a fake should be trivial

The right abstraction is a provider interface, not hardcoded clients.

**Decision**: An LLM provider layer modeled on the adapter framework (ADR-008).

- `@onenomad/przm-cortex-llm-core` — defines `LLMProvider` interface, request/response types,
  and a `LLMRouter` that resolves each call to a provider based on the task
  purpose (e.g., `structural`, `synthesis`, `brief`, `classify`) with a
  fallback chain.
- `@onenomad/przm-cortex-llm-sdk` — base classes, retry, rate-limit, OpenAI-compatible
  helper (reused by OpenRouter/OpenAI/Anthropic-compat/Google-compat).
- `@onenomad/przm-cortex-provider-ollama` — local, always available as primary in the
  author's setup.
- `@onenomad/przm-cortex-provider-openrouter` — cloud aggregator, one key covers many models.
- Future: `@onenomad/przm-cortex-provider-anthropic`, `@onenomad/przm-cortex-provider-openai`,
  `@onenomad/przm-cortex-provider-google` for BYOK direct providers.

Configuration is declarative in `config/cortex.yaml` under an `llm:` section:

```yaml
llm:
  providers:
    ollama:
      package: "@onenomad/przm-cortex-provider-ollama"
      enabled: true
      config:
        host: "${OLLAMA_HOST}"
    openrouter:
      package: "@onenomad/przm-cortex-provider-openrouter"
      enabled: true
      config:
        apiKey: "${OPENROUTER_API_KEY}"
  tasks:
    default:     { provider: ollama,     model: "qwen3:14b" }
    structural:  { provider: ollama,     model: "qwen3:14b" }
    synthesis:   { provider: openrouter, model: "anthropic/claude-haiku-4.5" }
    brief:       { provider: ollama,     model: "qwen3:14b" }
    classify:    { provider: ollama,     model: "qwen3:14b" }
  fallbackChain: [ollama, openrouter]
```

**Consequences**:
- Users can run Cortex fully local, fully cloud, or mixed with zero code
  changes.
- Swapping providers per task is a config edit, not a code edit. Enables
  quality/cost tuning without touching pipelines.
- Each provider is a standalone package: install only what you use, upgrade
  independently, clean dependency trees.
- Testing: a `@onenomad/przm-cortex-provider-mock` fixture package is trivial.
- Small complexity overhead in routing logic, paid once in `llm-core`.
- Supersedes ADR-004's "Ollama primary, OpenRouter fallback" as a hardcoded
  architecture. The defaults in cortex.yaml encode ADR-004's recommendation
  but no longer constrain the code.

## ADR-011: Research feature as a pipeline + `type: "reference"` memories (2026-04-22)

**Status**: Superseded 2026-05-10 — research moved to Pyre per
[Pyre Business Plan §16](https://onenomad.local/) (Cortex-Pyre Architecture
Boundaries). Cortex 0.5+ no longer ships the `research` / `approve_research`
MCP tools or the `pipeline-research` package; the `reference` content type
remains so Pyre can ingest synthesized briefs back into Cortex KB.

**Context**: The user asks Cortex to "research X" or "become an expert
in Y". This is fundamentally different from passive ingestion — it's
*active* knowledge building on demand. Cortex needs a shape for
storing synthesized expertise that doesn't look like a meeting brief
or a source-specific memory.

Three shapes were considered:

1. **Ad-hoc note type.** Reuse `type: note` with a `research:` tag.
   Rejected: collides with Obsidian's personal notes, loses the
   distinction that reference material shouldn't decay (ADR-002).
2. **Separate MCP tool with inline LLM calls.** Simple but makes the
   research flow look different from every other ingestion. No code
   reuse; testing becomes bespoke.
3. **A new pipeline + new content type.** Matches the existing
   pattern: source (the user's topic) → pipeline → memories. The
   "source" is synthetic — the user's request — but the downstream
   shape is identical to ingested docs.

**Decision**: Go with (3).

- **New content type**: `reference`. Added to `ContentType` in
  `@onenomad/przm-cortex-core`, to `memoryMetadataSchema`, and to the JSON schema
  at `schemas/memory-metadata.json`. Reference memories are intended
  for the `reference` cognitive layer proposed upstream in ADR-002;
  until Engram has that, they live in `semantic` with low decay.

- **New pipeline**: `@onenomad/przm-cortex-pipeline-research`. Takes a `{topic,
  retrievedContext[]}` input and emits:
  - One `reference` memory holding the synthesized brief.
  - N `reference` memories for the key facts/findings (one each,
    deduped by normalized claim text).
  - Optional `reference` memories for relevant source citations
    carried through from the retrieved context.

  Uses a two-pass LLM flow: pass 1 extracts structured facts from
  retrieved context + the topic, pass 2 synthesizes a brief.

- **New MCP tool**: `research(topic, depth?, sources?)`. Steps:
  1. Query Engram for prior memories related to the topic.
  2. Hand off to `pipeline-research` with that context.
  3. Ingest pipeline output back into Engram with
     `type: "reference"` and `tags: ["topic:<normalized>"]`.
  4. Return the brief + findings count.

- **Retrieval**: existing Engram semantic search surfaces `reference`
  memories alongside other types for related queries automatically.
  An explicit `what_do_i_know_about(topic)` tool can land later —
  same shape as `catch_me_up` but filters `type: reference`.

- **No external web in v1**. Retrieval uses only memories already
  ingested (Confluence, Notion, Loom, etc.) plus whatever the user
  passes inline via `sources`. Web fetching is a later enhancement
  behind a new `@onenomad/przm-cortex-adapter-web` or similar — the research flow
  doesn't have to be tied to its arrival.

**Consequences**:

- The user can say "research rate limiting strategies" and Cortex
  pulls from ingested Confluence/Notion/Loom memories, synthesizes a
  brief, and stores it. Next time someone asks a related question the
  brief + findings surface automatically.
- No new dependencies — `pipeline-research` reuses `@onenomad/przm-cortex-pipeline-core`
  and the LLM router just like every other pipeline.
- Reference material is finally distinguishable from transient content.
  Retrieval-quality improves because search can filter on
  `type: reference` to prefer curated over raw.
- Tight coupling to ADR-002 (Engram reference layer). Until that ships,
  we tag reference memories explicitly and adjust Engram decay params
  for them as a short-term mitigation.
- No Claude-tools-style recursive research in v1. That's a
  meaningful next step once this ships; the pipeline shape accommodates
  it (add a retrieval loop in pass 1).

## ADR-012: Native Postgres + pgvector backend as a fallback for Engram (2026-04-22)

**Status**: Accepted

**Context**: Engram is the default memory backend (ADR-001), consumed over
MCP. Two gaps:
1. If the Engram subprocess dies or isn't installed, every Cortex tool past
   `list_projects` breaks — we don't want the whole server to go dark.
2. Some deployments (a small Hetzner box that already runs Postgres for
   other services, a laptop without the Engram binary) would rather use a
   SQL store than run a second process.

**Decision**:

- New package `@onenomad/przm-cortex-memory-pgvector`. Implements the same ingest/search/
  healthCheck shape as the Engram MCP client using Postgres + `pgvector` for
  vector similarity and `tsvector` for full-text, fused via reciprocal rank
  fusion (k=60).
- Embeddings are an injected callback, not a hard dep on the LLM router —
  the package is independently testable.
- `LLMProvider` gains an optional `embed()` method; `LLMRouter.embed()`
  routes it the same way `complete()` is routed, skipping providers that
  don't implement it. Ollama ships with `/api/embed` support today.
- `config/cortex.yaml` gains a `memory:` block:
  ```yaml
  memory:
    primary: engram
    fallback: pgvector          # optional
    pgvector:
      connectionString: "${POSTGRES_URL}"
      embeddingDim: 768
  ```
- Boot policy: at startup, health-check the primary. If healthy, use it.
  If not, spawn the fallback; if that's healthy, run the whole session on
  it. If neither is healthy, refuse to start. Runtime per-call fallback
  was rejected: memory write paths are hard to reason about if they split
  mid-session, and operators prefer a clear log line over intermittent
  tool behavior.

**Consequences**:
- Cortex can now run without Engram installed at all, using pgvector as the
  primary. Also inverts: if the user prefers Engram's cognitive layers as
  primary and wants pgvector as a safety net, one line of config flips it.
- Adds a real (non-MCP) dep on `pg`. Kept inside `@onenomad/przm-cortex-memory-pgvector`;
  core packages stay clean.
- `embed` is now a first-class TaskPurpose. Adapters and pipelines could
  consume it later (semantic dedup during ingest, for example) without
  another refactor.
- The same SQL store can be used by upstream Engram if that project ever
  grows a Postgres backend — the schema is deliberately close to what a
  LanceDB equivalent would hold.

## ADR-013: Push-based ingestion — stream() + webhook() on SourceAdapter (2026-04-22)

**Status**: Accepted

**Context**: Every adapter polls on a cron schedule. That works, but the
cadence has real costs:
- Loom polls every 15 minutes; a meeting that ended 30s ago takes up to
  15 minutes to show up in `catch_me_up`.
- Obsidian has no schedule at all — notes only sync when the user runs
  `cortex sync obsidian` manually, and the filesystem adapter has always
  had a `supportsRealTime: false` flag begging to be flipped.
- Several adapters declare `supportsWebhooks: true` but nothing consumes
  the signal.

**Decision**: Two optional methods on the `SourceAdapter` interface that
coexist with `fetch()`:

- `stream?(ctx): AsyncIterable<RawSourceItem>` — long-running iterator
  the server subscribes to at boot. Implementations respect `ctx.signal`
  so shutdown can unwind cleanly. Pilot: Obsidian via chokidar.
- `webhook?(ctx): WebhookHandler | WebhookHandler[]` — returns one or
  more handlers each with a `path`, `verify(req)`, and `parse(req)`. The
  server mounts a tiny `node:http` receiver when `webhooks.enabled:
  true` in cortex.yaml. Pilot: GitHub push events with HMAC-SHA256
  signature verification.

All three entry points (cron `fetch`, long-running `stream`, inbound
`webhook`) funnel through one shared `processItem()` helper so
transform → classify → pipelines → ingest behaves identically no matter
how the item arrived.

**Consequences**:
- Real-time ingestion becomes opt-in per adapter. Obsidian saves now
  propagate in under a second rather than not at all.
- `stream()` runs ALONGSIDE the cron `fetch()`, not in place of it.
  Dropped fs events (common during editor saves) get picked up by the
  next scheduled walk.
- Webhook path responds 204 BEFORE running `processItem()`, so slow
  pipelines don't widen the provider's retry window (GitHub retries at
  10s).
- Each pushed item gets its own `trace_id` (not the stream session's)
  so operator queries map to a single user action rather than a whole
  session.
- Exposing the webhook port publicly is an operator concern — Tailscale
  Funnel, reverse proxy, or ngrok. The code just binds to 0.0.0.0:PORT.
- GitHub webhooks require `GITHUB_WEBHOOK_SECRET`. The adapter refuses
  to mount without it — unsigned GitHub webhooks are trivially
  spoofable and silently running in that state is worse than failing
  loud.

## ADR-014: Declarative module wizards + category-aware config writes (2026-04-22)

**Status**: Accepted

**Context**: Every source adapter, LLM provider, memory backend, and the
webhook receiver needs the same tedious plumbing: ask the operator for
configuration, validate it, write adapter settings to
`config/cortex.local.yaml`, secrets to `.env`, and any derived projects
to `config/projects.local.yaml`. First pass had that logic split across
ad-hoc `README` snippets and one-off CLI subcommands, which scaled
poorly — every new adapter wanted its own wizard and the team cost of
"write a good setup flow" was pushing some modules out of reach.

A second force: the dashboard (Sprint C) needs the same flows, but as
web forms. Duplicating each prompt in a React component would immediately
drift from the CLI version.

**Decision**: Two pieces, one source of truth:

- **`WizardModule` — declarative spec in `@onenomad/przm-cortex-core/wizard`.** Each
  module exports a `WizardModule` describing its steps, secrets,
  category, and an optional `derivedTaxonomy` hook. Step kinds are a
  closed enum (`text`, `password`, `boolean`, `select`, `list`,
  `repeat-per`, `record`) that any renderer can handle without
  framework coupling — no React, no inquirer leaking into the spec.
- **Category-aware `config-mutation.applyWizardResult`.** The runner
  attaches the module's category (`adapter` | `provider` | `memory` |
  `toolkit` | `webhook`) to the `WizardResult`, and the mutation
  service branches on it:

  | category | lands at |
  |---|---|
  | adapter | `adapters.<id> = { package, enabled, config }` |
  | provider | `llm.providers.<id> = { package, enabled, config }` |
  | memory | `memory.<id> = config` (+ `memory.fallback = <id>`) |
  | webhook | `webhooks = { ...webhooks, ...config }` |
  | toolkit | `toolkits.<id> = config` |

  All writes go through the same atomic tmp-then-rename path;
  `.env` merges dedupe by key; `projects.local.yaml` merges dedupe by
  slug. One generic pipe from every wizard shape.

**Consequences**:
- Adding a new module becomes: "write one wizard.ts, register it once."
  Every adapter, provider, memory backend, and the webhooks receiver
  now have wizards with the same shape and coverage.
- The CLI runner (`@inquirer/prompts`) and future dashboard form
  renderer consume the same specs. Any step type both renderers
  understand is covered everywhere for free.
- Shared Atlassian credentials across Confluence / Jira / Bitbucket
  fall out of the `.env`-merge semantics — re-entering the token
  during a second wizard run is a no-op instead of a duplicate.
- Zod schemas that use `.default()` / `.preprocess()` need a
  `z.ZodTypeAny` typing on the spec's `configSchema` field because
  preprocessing diverges input and output types. Runtime parsing still
  enforces the concrete `TConfig`.
- Google adapters (gmail, google-calendar, google-drive) don't fit the
  step model — they need an OAuth loopback handshake instead of
  prompts. Those are a sidecar: `cortex google-login` runs the
  interactive OAuth flow and writes a shared refresh token; the three
  adapter wizards stay declarative, collect adapter-specific config
  only, and the CLI pre-flights the token before the wizard runs.
- Obsidian's `pathToProject` is an *ordered* array of `{prefix,
  project}` rather than a flat record. The wizard collects a list of
  prefixes, a per-prefix project via `repeat-per`, and a
  `z.preprocess()` rebuilds the ordered array from insertion order.
  Future adapters that need ordered mappings follow the same pattern.

## ADR-015: Local-per-user dashboard, HTTP sidecar data plane (2026-04-22)

**Status**: Accepted

**Context**: Cortex is a single-user daily driver. The MCP tools work great
inside Claude Code, but there's a class of information — "what do I owe
people today?", "what meetings do I have and am I prepped?", "what changed
across my 12 projects since yesterday?" — where a glanceable dashboard beats
a prompt round-trip. Low-friction UX: scannable, no typing.

Three shape questions decided up-front because they're hard to reverse:

1. **Deployment.** Vercel vs. Tailscale-local vs. bundled with `cortex start`.
2. **Data plane.** How the dashboard reaches Engram + Cortex domain data.
3. **Widget system.** Flat components vs. pluggable registry.

**Decision**:

- **Local-per-user.** Each user runs `cortex dashboard` on their own
  machine, next to `cortex start`. No hosted tenant, no auth, no shared
  deployment. The dashboard is a thin client over the local MCP server.
  If federation happens later (ADR-016, pending), the data model changes
  but the deployment model doesn't.

- **HTTP sidecar on `cortex start`.** An optional HTTP API — off by default,
  mirroring the webhooks pattern — serves widget-shaped JSON (`GET
  /api/widgets/<name>`). The dashboard hits `http://localhost:<port>`.
  Rationale: one Engram subprocess per host, one project taxonomy, one
  LLM router. Forking a second stdio MCP subprocess just to serve the
  dashboard would double resource cost and create two sources of truth
  for things like "today's meetings."

  The sidecar is bound to `127.0.0.1` by default. Tailscale reachability
  is opt-in via a host override — the same posture as webhooks.

- **Flat React components, one package.** `@onenomad/przm-cortex-dashboard` is a single
  Next.js 15 app. Widgets are React components in `src/widgets/`, each
  with a typed data contract matching the sidecar's JSON response. No
  plugin registry, no runtime discovery. Adding a widget: write a route
  handler server-side, write a component client-side, register it in
  `config/dashboard.yaml`.

  The "extract `@onenomad/przm-cortex-widget-core` later" option stays open — the
  signal will be a second consumer (e.g. a team leaderboard fed by the
  federation layer). Until then, it's premature.

- **Six starter widgets**, chosen for a delivery-focused role with a
  nod to devs who'll land on Cortex later:
  1. **Priorities** — top commitments across all projects, ranked by
     due date + recency
  2. **Today's meetings** — today's calendar with pre-meeting brief link
  3. **My action items** — open action items with status + owner + due
  4. **Recent activity** — newly-ingested memories since last view,
     grouped by project
  5. **Recent decisions** — decisions extracted across all projects,
     newest first
  6. **Code activity** — PR/commit activity from GitHub/Bitbucket
     adapters; degrades to empty state when no code adapter enabled

  Widget 6 is the only "dev-shaped" one; widgets 1–5 serve both a PM and
  a contributor equally well.

- **Layouts in `config/dashboard.yaml`.** YAML describes row/column
  composition and per-widget props. Role presets (`delivery`,
  `developer`) ship as defaults operators can fork.

**Consequences**:

- Adding a new widget is two files + one config entry. No registry to
  keep in sync.
- Zero auth code. If multi-user federation ever happens, the HTTP
  sidecar grows a token check; today the localhost bind is the boundary.
- The HTTP sidecar reuses the exact same Engram client, LLM router, and
  taxonomy as `cortex start`'s MCP tools — any query a widget runs is
  writable as an MCP tool and vice versa. No duplicated query logic.
- Dashboard deploys are `pnpm --filter @onenomad/przm-cortex-dashboard build` +
  `cortex dashboard` — no Vercel, no Docker required. Users who want
  hosted access point a reverse proxy at the local instance themselves.
- The HTTP port is a new surface. Defaulting to localhost-only mitigates
  most risk, but the sidecar must not start unless the operator flips
  `api.enabled` — doctor will warn when it's enabled without auth *and*
  bound non-locally.
- If the v1 widget set proves wrong, we replace widgets, not
  architecture — the sidecar contract and layout YAML absorb the churn.

## ADR-016: Federated memory with `@onenomad/przm-cortex-memory-remote` (2026-04-22)

**Status**: Accepted

**Context**: Cortex runs Engram as a local stdio subprocess — personal
memory, single-user, private. That's the right default for a heads-down
personal daily driver. But two scenarios break the single-Engram model:

1. **Team knowledge.** Shared decisions, meeting outcomes, and project
   docs are useful across a team. "Was that decision we made on alpha
   last quarter in my notes or was it in Jake's?" is a question you
   want to answer without pinging Jake.
2. **Multi-machine continuity.** Users work across a laptop and a
   desktop. Personal memory that only lives on one host is a regression
   from the Obsidian-sync world where notes travel.

Options considered:

- **A. Single backend.** Pick one — personal local OR team remote.
  Simplest, but forces a false choice.
- **B. Workspace switch.** User toggles between "personal" and "team"
  contexts. Loses cross-workspace search, which is the multi-context
  use case ("remind me of that thing — was it in a meeting or in my
  notes?").
- **C. Hybrid cache.** Team Engram as source of truth, local as
  warm cache. Cache coherence problems in a multi-writer world make
  this complex enough to punt.
- **D. Federated fan-out.** Cortex holds multiple Engram clients;
  search fans out in parallel and merges results. Writes route by
  explicit target. Chosen.

**Decision**:

- **`@onenomad/przm-cortex-memory-remote`** is a new package that implements the same
  `EngramClient` interface as the local stdio client, but over HTTP.
  It talks to Engram's existing HTTP MCP transport (already supported
  upstream) or a thin JSON shim in front of it — whichever turns out
  cleaner on implementation.

- **Multiple backends per Cortex instance.** `cortex.yaml` grows a
  `memory.remotes[]` list. Each entry has a slug, a URL, optional
  auth, and a list of `domain` tags it owns (e.g. `team-alpha` or
  `examplecorp`). The existing `memory.engram` + `memory.pgvector`
  stays as the personal backend.

- **Read = parallel fan-out.** `search()` dispatches the query to
  every enabled backend concurrently. Results are merged and ranked
  by the highest score per `source_id`. Each result carries a
  `_backend` slug so the UI can show provenance and doctor can
  attribute failures.

  Partial results are fine: if the team backend times out at 500ms,
  the user still gets local hits. The widget/tool layer doesn't have
  to care — the merged client handles it.

- **Write = explicit routing.** `ingest()` takes an optional
  `backend` slug. When omitted, writes go to the default backend
  (personal local). Adapters that belong to shared sources (team
  Confluence spaces, shared Bitbucket repos) get a `backend:` option
  in their `cortex.yaml` entry that sets the target. No dual-writes,
  no silent fan-out on writes.

- **Auth is pluggable, not baked in.** The remote client accepts an
  `authorization` builder function that returns a bearer. Simple
  shared-secret for v1 (`CORTEX_REMOTE_<slug>_TOKEN` env var); OAuth
  or mTLS are later additions that don't change the memory contract.

- **Domain metadata is load-bearing.** The `domain` field in memory
  metadata (already in the contract: `"work"` for everything today)
  evolves to be the routing key. Personal memories get
  `domain: "personal"` or stay `domain: "work"` for backwards
  compat; shared memories get `domain: "team:<slug>"`. Search filters
  naturally respect domain, so "only personal" and "only team" views
  are the same query with one more filter.

- **Doctor grows per-backend probes.** `cortex doctor --connect`
  already live-probes the primary Engram. With ADR-016, it walks
  every configured remote in the same way and reports per-slug
  health. Unreachable remotes are warnings, not failures, since
  fan-out still works without them.

**Consequences**:

- The dashboard gains provenance. A decision pulled from
  `team-alpha` can show a small badge; a personal note from local
  Engram shows its own. Users know which source they're trusting.
- One-way federation is possible by default: personal → team by
  configuring only a team write for specific adapters, team → personal
  by leaving personal writes alone. No explicit sync job needed.
- `engram-remote` adopters who don't want local Engram can run
  Cortex with zero local subprocess — remotes only. Doctor's
  current hard dependency on an Engram subprocess becomes a soft one.
- Permissioning is Engram's problem, not Cortex's. If a team instance
  wants per-user ACLs, that's an Engram feature Cortex consumes via
  the auth builder.
- Writes never silently propagate to a shared backend. Operators who
  set `backend:` on an adapter have opted in. This is the main
  insurance policy against accidental data sharing.
- Cache coherence is a non-problem because we chose fan-out over
  cache. The cost is one network round-trip per query per remote,
  paid in parallel.
- A future `@onenomad/przm-cortex-memory-pgvector-remote` or any other backend is
  the same shape: implement `EngramClient`, register in `memory.remotes`.

**Open for v1 impl**:
- Score merging function (simple max-by-source_id or weighted?).
  Start with max; revisit if ranking feels off.
- Timeout budget per fan-out. 500ms default, per-backend override in
  config.
- Whether the memory contract gains a `source_backend` required field
  or whether `_backend` stays a runtime-only annotation.

---

## ADR-017: Docker + Tailscale as the primary run path (2026-04-23)

**Status**: Accepted

**Context**: Cortex started as "install globally with `npm install -g
@onenomad/przm-cortex`, run `cortex start` on your laptop." On Windows
that story broke repeatedly: PowerShell's `Start-Process` detach
semantics, console-job cascades that killed "detached" children when
the parent terminal closed, and the `spawnSync` hangs that motivated
this ADR. A laptop sleeps, closes, moves — an always-on daemon
on the laptop is the wrong shape anyway.

Options considered:

- **A. Keep the npm-global path, fight the Windows detach story.**
  Possible but fragile; every future CLI change risks re-breaking the
  process tree on Windows. Net sink.
- **B. Force systemd on Linux only, Mac launchd, Windows service.**
  Three separate per-OS daemons with different failure modes. High
  maintenance cost for a single-user project.
- **C. Docker + docker compose as the primary run path; `cortex
  start` becomes a foreground-only dev command.** One container
  topology works identically on laptop, VPS, and CI. Chosen.

**Decision**:

- **Docker compose is the primary run path.** `packages/server/Dockerfile`
  and `packages/dashboard/Dockerfile` produce two images; a single
  `docker-compose.yml` wires them with a bind-mount for workspace
  state. The CLI ships `cortex up / down / logs` as thin
  `docker compose` wrappers so users don't have to remember flags.

- **`cortex start` is foreground-only now.** It boots Cortex in the
  current terminal, spawns the Next.js dashboard as a child (the
  old auto-start behavior), and dies on Ctrl+C. No PID file, no
  detach, no `stop` / `restart` CLI commands — `cortex up` / `down`
  cover the daemon case. The detach plumbing (detach.ts,
  pid-file.ts, restart.ts) is removed.

- **Workspace state bind-mounts to `PRZM_CORTEX_HOME_HOST`.** The user
  points the env var at a host path (default `./.cortex-data`).
  Workspaces, OAuth tokens, and engram/persona LanceDB data all
  persist there. Users can point it at an existing `~/.cortex` to
  reuse workspaces they already built.

- **Dashboard is its own compose service.** Not a child process of
  cortex. Lets the dashboard restart independently, exposes
  `docker compose logs dashboard` as a first-class command, and
  gives a clean "one process per responsibility" topology.

- **Recommended remote deploy path: Docker on a VPS behind
  Tailscale.** ADR-005 already named Hetzner + Tailscale as the
  hosting target; this ADR is the concrete "how." Tailscale keeps
  the dashboard and MCP endpoints private without requiring an
  auth layer in front. Documented in `docs/DEPLOY.md`.

- **Default LLM flips to OpenRouter.** Ollama was the default when
  Cortex assumed a local GPU box. A VPS has no GPU, so OpenRouter
  (BYOK cloud aggregator) is the default for new setups; Ollama
  stays as an opt-in toggle for users with local hardware.

**Consequences**:

- Users need Docker installed. That's a real barrier compared to
  npm-global, but it's a one-time barrier — every other layer of
  the system gets simpler afterwards.
- Windows users aren't second-class anymore. The container runs
  identically on Docker Desktop (Windows/Mac) and native Linux.
- The `@onenomad/przm-cortex` npm package still ships for folks who want
  to embed Cortex as a library or run it in their own orchestrator,
  but the documented path is `docker compose up`.
- Obsidian adapter (Phase 9) now needs a filesystem bridge —
  either a second bind mount for the vault path or a sidecar that
  streams vault changes to the VPS over Tailscale. Deferred; the
  adapter isn't built yet.

---

## ADR-018: Session-scoped workspaces via AsyncLocalStorage (2026-04-23)

**Status**: Accepted

**Context**: Pre-ADR-017 Cortex ran as a per-user npm-global CLI — one
user, one process, one "active workspace" tracked in `~/.cortex/state.json`.
ADR-017 flipped that: Cortex now runs as a shared container, and
multiple Claude clients (Claude Code on laptop, Claude Desktop, the
browser extension, another Claude Code session in a different repo)
all connect to the *same* MCP server process concurrently.

The "one active workspace per process" model is wrong for that topology.
A user might have two workspaces (e.g. `alpha` and `beta`); a Claude Code
session inside `~/work/alpha` should see alpha memories, while a
second session inside `~/work/beta` should see beta memories —
simultaneously, in the same server process.

Tools that read per-workspace state:
- Memory search (project taxonomy, ingest, search filters)
- Identity + user profile (`update_user_identity`, `get_user_identity`)
- Adapter config (which adapters enabled, tokens, schedules)
- Action items + briefs + digests (workspace-filtered search)

Options considered:

- **A. Workspace as an explicit parameter on every tool.** Rejected:
  Claude would have to thread the slug through every call — ergonomic
  regression and a new vector for "Claude forgot to pass it and got
  the wrong workspace's data." MCP tool schemas are supposed to stay
  small.
- **B. Per-session MCP servers (one subprocess per client).** Rejected:
  contradicts ADR-017's container story, quintuples memory footprint,
  and the browser extension's WS bridge needs exactly one process.
- **C. AsyncLocalStorage-propagated session id, looked up against an
  in-memory map of SessionState.** Chosen. The MCP streamable HTTP
  transport already carries `mcp-session-id` per request; bind it at
  the transport seam and every tool handler can read it implicitly.

**Decision**:

- **`packages/server/src/session-context.ts`** owns the primitive:
  an `AsyncLocalStorage<{ sessionId }>` paired with a
  `Map<sessionId, SessionState>`. `SessionState.workspace` is
  `string | null | undefined` — undefined = never picked (fall back
  to the state.json active pointer, backwards compat), null = user
  explicitly chose "no workspace", string = bound.

- **HTTP transport (`transport.ts`)** wraps every `handleRequest` in
  `runWithSession(sessionId, ...)` so per-request ALS scoping works.
  Concurrent requests stay isolated because `ALS.run` is callback-
  scoped.

- **Stdio transport** uses `enterSession(sessionId)` at startup
  (`ALS.enterWith`) because the MCP SDK owns the stdin read loop —
  we can't wrap individual tool calls. Stdio is one subprocess =
  one client = one workspace for the process lifetime, so persistent
  context is the right shape.

- **Two new MCP tools**: `get_session_workspace` and
  `set_session_workspace`. The system prompt tells Claude to call
  `get_session_workspace` first every conversation; if unbound,
  prompt the user with `list_workspaces` output and bind their
  choice via `set_session_workspace`.

- **`session-workspace-helpers.ts`** bridges the session binding to
  the on-disk workspace manager. `requireSessionWorkspace()` throws
  a clear error when nothing is resolvable; `maybeSessionWorkspace()`
  returns null for tools that can degrade gracefully. Resolution
  order: session binding → state.json active pointer → error.

- **`TaxonomyCache`** holds a per-workspace `LoadedTaxonomy` lazily,
  keyed by slug. Hit from the MCP server's per-call context setup:
  the tool sees the taxonomy for its session's workspace, not a
  process-global taxonomy. Mutation tools (`add_person`,
  `add_project`, `update_user_identity`) call
  `ctx.invalidateTaxonomy(slug)` after writing so the next read
  re-loads from disk. In-flight promise dedup prevents thundering
  herd on first concurrent access.

- **Engram search filter is client-side**: `filterByWorkspace(rows,
  slug)` runs after engram returns. Engram has no concept of Cortex
  workspaces and we don't want it to — the filter is a Cortex
  concern. Legacy memories (no `workspace` field in metadata) pass
  through so pre-scoping ingests remain findable. Ingest stamps
  `metadata.workspace` going forward.

- **Session GC** runs hourly, evicting sessions last seen >24h ago.
  Prevents the map from growing unbounded as ephemeral clients
  come and go.

**Consequences**:

- The first tool call in a new Claude conversation is
  `get_session_workspace`. That's one extra round-trip per session,
  acceptable for the isolation guarantee.
- Old clients that haven't learned the `get_session_workspace` flow
  still work via the state.json fallback — `cortex workspace switch`
  still flips the default. New clients (system prompt updated) pick
  per-session.
- Tests are the only callers that currently invoke `enterSession`
  directly; HTTP uses `runWithSession`. Keeping the two separate is
  intentional — `enterWith` in the HTTP path would leak context
  across requests.
- Schedulers + webhook handlers + cron ticks have no ALS context,
  so they fall back to the state.json active pointer. For now
  that's acceptable — cron is inherently process-global in scope.
  A future ADR will revisit if we need per-workspace schedulers
  (probably via spawning one cron loop per workspace).
- Memory footprint: one `SessionState` is a few bytes; the
  taxonomy cache holds two YAML trees per active workspace — a
  few KB each. Bounded by `workspaces * sessions seen in the
  last 24h`, which for a personal deployment is `O(10)`. Fine.

---

_Add new ADRs below this line._

## ADR-020: LLM ingest-time extractors (summary + keywords) (2026-05-27)

**Status**: Accepted

**Context**: Both the `tsv` full-text column and the embedding vector were keyed off raw `content` only. Domain jargon and gist-level concepts absent from the ingested text were invisible to both retrieval channels. No production corpus exists, so the embedding/tsvector seam can be changed at zero migration cost.

**Decision**: Add a uniform `Extractor` interface (`packages/server/src/enrichment/extractor.ts`) with a runner that merges `Partial<MemoryMetadata>` patches from enabled extractors. Ship two v1 extractors: `summary` (1–3 sentence gist → `metadata.summary`) and `keywords` (domain terms/jargon → `metadata.keywords[]`). Both are off by default, opt-in via the new `extractors` block in `cortex.yaml`. The `tsv` generated column now includes `coalesce(metadata->>'summary','')` and the joined keyword array, so rows without enrichment produce the identical tsvector as before. Ingest composes `embedText = content + summary + keywords` when enrichment is present, while `content` stays stored as-is. See `docs/adr-020-llm-ingest-extractors.md` for full detail.

**Consequences**: Improved recall on jargon-gap and gist-level queries when extractors are enabled. Default behaviour (no extractor configured) is byte-identical to pre-ADR-020. The metadata contract grows by two optional fields (`summary`, `keywords`); the conformance test guards drift. Dev DBs bootstrapped before this release need recreation (the generated column expression changed; the bootstrap DDL includes an idempotent DO block that upgrades existing tables). Re-embedding is not required for existing rows — they have no enrichment and embed the same content they always did.

## ADR-021: przm-access integration into cortex — multi-tenant RLS + Principal (2026-05-27)

**Status**: Accepted (shape resolved; no code written yet — implementation gated on an explicit go, Phase 0 first)

**Context**: `przm-access` milestone 1 shipped the identity/tenancy/access spine (contract package `@onenomad/przm-access` + service + EdDSA tokens + RLS pattern). cortex is the first plane to integrate it — this doubles as cortex's standalone multi-user knowledgebase work. Grounded findings: the pgvector backend is `pool.query`-only with no transaction path (`SET LOCAL app.tenant` needs one); `workspace` is a nullable TEXT slug (RLS must key on a stable UUID); PGlite (WASM, single superuser) cannot enforce production RLS; the MCP HTTP transport already has a scoped-JWT bearer path to mirror, while stdio has no header channel.

**Decision**: (D1) RLS is external-Postgres-only; embedded/PGlite stays app-layer-filtered and single-tenant. (D2) Add a stable `tenant_id uuid` column now; RLS keys on it, the `workspace` slug stays human-facing. (D3) Adopt the `@onenomad/przm-access` contract and grow the external pool to a `withRlsSession`-capable scoped session. (D4) Two DB roles in external mode (privileged for DDL, restricted non-`BYPASSRLS` for queries) — the same gap flagged in przm-access `createPgPool`, fixed once in both repos. (D5) The przm-access EdDSA token rides the existing HTTP `Authorization: Bearer` channel → `Principal` stamped on the session → threaded into the query path; stdio stays local/single-tenant. (D6) The dashboard derives its `Principal` from the GitHub-login session, closing the workspace-leak class structurally. (D7) Legacy `OR workspace IS NULL` "visible everywhere" rows do not survive into external RLS (greenfield, no backfill). Resolved questions: `tenant_id` added now; NULL rows vanish under RLS; przm-access `tenant` table is the slug↔uuid source of truth; the contract package ships on public npm (`@onenomad/przm-access@0.1.0`, `access: public` — npmjs requires a paid plan for private scoped packages, and the contract carries no secrets). See `docs/adr-021-przm-access-cortex-integration.md` for full detail and the five-phase plan.

**Consequences**: Phased delivery — Phase 0 closes the przm-access two-role gap + adds a real-Postgres RLS test (prerequisite); Phase 1 adds `tenant_id` + guarded RLS policies (external-only, no embedded behavior change); Phase 2 grows the scoped query path; Phase 3 wires the token + dashboard Principal; Phase 4 adds project/role scoping. Open validation items: transaction-per-op perf vs PgBouncer (Phase 2), real-Postgres CI for the RLS claim (Phase 1). Embedded/local cortex and its zero-infra promise are unchanged throughout.
