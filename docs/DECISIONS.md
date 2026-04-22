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
`@cortex/core`. The Cortex server has a registry that loads enabled adapters
at startup based on `config/cortex.yaml`. Pipelines (meeting extraction, doc
chunking, code indexing) are also modular packages that adapters declare
they use.

Package layout:
- `@cortex/core` — shared types, interfaces, context
- `@cortex/adapter-sdk` — base classes, retry, rate-limit, idempotency,
  default classifiers
- `@cortex/pipeline-core` — generic pipeline framework
- `@cortex/pipeline-*` — specific pipelines (meeting, doc, code, ...)
- `@cortex/adapter-*` — specific adapters (loom, confluence, obsidian, ...)
- `@cortex/server` — MCP server, registry, scheduler, clients

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

- `@cortex/llm-core` — defines `LLMProvider` interface, request/response types,
  and a `LLMRouter` that resolves each call to a provider based on the task
  purpose (e.g., `structural`, `synthesis`, `brief`, `classify`) with a
  fallback chain.
- `@cortex/llm-sdk` — base classes, retry, rate-limit, OpenAI-compatible
  helper (reused by OpenRouter/OpenAI/Anthropic-compat/Google-compat).
- `@cortex/provider-ollama` — local, always available as primary in the
  author's setup.
- `@cortex/provider-openrouter` — cloud aggregator, one key covers many models.
- Future: `@cortex/provider-anthropic`, `@cortex/provider-openai`,
  `@cortex/provider-google` for BYOK direct providers.

Configuration is declarative in `config/cortex.yaml` under an `llm:` section:

```yaml
llm:
  providers:
    ollama:
      package: "@cortex/provider-ollama"
      enabled: true
      config:
        host: "${OLLAMA_HOST}"
    openrouter:
      package: "@cortex/provider-openrouter"
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
- Testing: a `@cortex/provider-mock` fixture package is trivial.
- Small complexity overhead in routing logic, paid once in `llm-core`.
- Supersedes ADR-004's "Ollama primary, OpenRouter fallback" as a hardcoded
  architecture. The defaults in cortex.yaml encode ADR-004's recommendation
  but no longer constrain the code.

## ADR-011: Research feature as a pipeline + `type: "reference"` memories (2026-04-22)

**Status**: Accepted

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
  `@cortex/core`, to `memoryMetadataSchema`, and to the JSON schema
  at `schemas/memory-metadata.json`. Reference memories are intended
  for the `reference` cognitive layer proposed upstream in ADR-002;
  until Engram has that, they live in `semantic` with low decay.

- **New pipeline**: `@cortex/pipeline-research`. Takes a `{topic,
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
  behind a new `@cortex/adapter-web` or similar — the research flow
  doesn't have to be tied to its arrival.

**Consequences**:

- The user can say "research rate limiting strategies" and Cortex
  pulls from ingested Confluence/Notion/Loom memories, synthesizes a
  brief, and stores it. Next time someone asks a related question the
  brief + findings surface automatically.
- No new dependencies — `pipeline-research` reuses `@cortex/pipeline-core`
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

- New package `@cortex/memory-pgvector`. Implements the same ingest/search/
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
- Adds a real (non-MCP) dep on `pg`. Kept inside `@cortex/memory-pgvector`;
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

- **`WizardModule` — declarative spec in `@cortex/core/wizard`.** Each
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
a prompt round-trip. ADHD-friendly UX: scannable, no typing, low-friction.

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

- **Flat React components, one package.** `@cortex/dashboard` is a single
  Next.js 15 app. Widgets are React components in `src/widgets/`, each
  with a typed data contract matching the sidecar's JSON response. No
  plugin registry, no runtime discovery. Adding a widget: write a route
  handler server-side, write a component client-side, register it in
  `config/dashboard.yaml`.

  The "extract `@cortex/widget-core` later" option stays open — the
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
- Dashboard deploys are `pnpm --filter @cortex/dashboard build` +
  `cortex dashboard` — no Vercel, no Docker required. Users who want
  hosted access point a reverse proxy at the local instance themselves.
- The HTTP port is a new surface. Defaulting to localhost-only mitigates
  most risk, but the sidecar must not start unless the operator flips
  `api.enabled` — doctor will warn when it's enabled without auth *and*
  bound non-locally.
- If the v1 widget set proves wrong, we replace widgets, not
  architecture — the sidecar contract and layout YAML absorb the churn.

---

_Add new ADRs below this line._
