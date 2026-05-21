# Roadmap

Canonical build order and current state. Update after every meaningful session.

## Current Phase

**Sprint C (dashboard widgets) complete.** Local-per-user Next.js 15
dashboard shipping eight widgets end-to-end: priorities, today-meetings
(live Google Calendar), upcoming-briefs (wraps the MCP tool),
my-action-items, recent-decisions, recent-activity, code-activity,
who-knows. Layout is config-driven via `config/dashboard.yaml` with
role presets (delivery, developer, custom) merged at request time so
editing the YAML doesn't require a restart. Widget names unknown to
the component registry render a placeholder so presets can reference
future widgets without breaking the page. See ADR-015 for the
local-per-user + HTTP-sidecar posture.

**Surface area:** nine MCP tools + eight dashboard widgets live.
Twelve source adapters + five pipelines (doc, meeting, code,
conversation, research). LLM classifier fallback on every adapter.
Cron scheduler drives ingestion inside `cortex start`. Push-based
ingestion via `stream()` (Obsidian chokidar) and `webhook()` (GitHub
+ Slack) per ADR-013. Native Postgres + pgvector fallback for Engram
per ADR-012. `cortex doctor --connect` live-probes Engram + Postgres.
`cortex dashboard` spawns the Next.js dev server with PRZM_CORTEX_API_URL
derived from cortex.yaml. 138+ server tests, plus adapter/provider/
pipeline tests across the workspace.

Remaining work splits into:
- **Step 0b (federation)** — `@onenomad/przm-cortex-memory-remote` for hybrid
  personal-local + shared-team Engram. Architectural ADR pending.
- **Sprint C polish** — wizard-spec-driven admin forms (the "web
  forms for every wizard module" goal from the original Sprint C
  vision). The dashboard widget grid is done; the setup/configure
  UI path is not.
- **Upstream** — Engram `reference` cognitive layer (ADR-002), live
  Confluence smoke against real Atlassian, live Google OAuth smoke
  against a real consent screen.

## Phase 0: Setup (manual, pre-development)

- [x] Ollama installed on Windows with GPU acceleration (9070 XT)
- [x] Tailscale on Windows + Mac
- [x] Repository created and initialized
- [x] CLAUDE.md, README.md, docs/ committed
- [x] Name decided: Cortex
- [ ] Engram and Persona running locally on Windows
- [ ] Initial `config/projects.yaml` populated with real projects
- [ ] Initial `config/people.yaml` populated with known teammates
- [ ] Source credentials gathered: Loom API key, Atlassian API token

## Phase 1: Foundation

- [x] Monorepo scaffold (pnpm workspaces, tsconfig.base, CI, docker-compose)
- [x] `@onenomad/przm-cortex-core` — SourceAdapter, types, metadata contract
- [x] `@onenomad/przm-cortex-adapter-sdk` — BaseAdapter, retry, rate-limit, classifier stubs
- [x] `@onenomad/przm-cortex-pipeline-core` — Pipeline interface, stage runner
- [x] `@onenomad/przm-cortex-llm-core` — LLMProvider interface + LLMRouter (ADR-010)
- [x] `@onenomad/przm-cortex-llm-sdk` — BaseLLMProvider, OpenAI-compatible base, retry, http
- [x] `@onenomad/przm-cortex-provider-ollama` — real HTTP impl, unit tests
- [x] `@onenomad/przm-cortex-provider-openrouter` — real HTTP impl, unit tests
- [x] `@onenomad/przm-cortex-server` — MCP skeleton (zero tools), config loader, provider
      registry, adapter registry stub
- [x] `.env.example` with all required variables
- [x] Docker Compose for Cortex + Engram + Persona local dev
- [x] `schemas/memory-metadata.json` JSON Schema
- [x] `config/cortex.yaml` with all adapters disabled
- [ ] `pnpm install` and verify full tree builds
- [ ] Live smoke test: Ollama (Windows, Qwen 3 14B) via Tailscale
- [ ] Live smoke test: OpenRouter (Haiku)
- [ ] Engram MCP client implementation (replace stub)
- [ ] Persona MCP client implementation (replace stub)
- [ ] Claude Code connects to Cortex MCP and sees the server

Exit criteria: `pnpm dev` starts Cortex MCP, connects to Engram and Persona,
and can ping both. Claude Code can connect to Cortex MCP and see the server.
Ollama and OpenRouter clients both work in isolation against live endpoints.

## Phase 2: Project Taxonomy

- [x] `config/projects.yaml` schema (Zod) in `@onenomad/przm-cortex-core`
- [x] `config/people.yaml` schema (Zod) in `@onenomad/przm-cortex-core`
- [x] Domain types: `Project`, `Person` (zod-inferred)
- [x] Taxonomy loader with validation and lookup index
- [x] MCP tool: `list_projects` (with `activeOnly` filter)
- [x] MCP tool: `get_project_context` (config-only — recent activity stubbed
      pending real Engram client)
- [x] MCP tool framework (`McpTool`, `ToolContext`, tool registry)
- [x] Tests with fixture config files (15 server tests total)
- [x] Real Engram client (stdio MCP subprocess, typed ingest/search/health)
- [x] Real Persona client (stdio MCP subprocess, cognitiveLoad/signal/health)
- [x] get_project_context pulls recent activity from Engram

Exit criteria: Ask Claude Code in claude.ai "what projects am I working on"
and get a real answer from Cortex. Tools appear in `/mcp` tool listing.

## Phase 3: Meeting Pipeline (Fixtures First)

Build the extraction pipeline before wiring it to Loom. Using fixtures first
means iteration is fast and doesn't depend on real meetings being available
on demand.

- [ ] Sample transcripts in `tests/fixtures/meetings/` (sanitize any real ones)
- [ ] Pass 1 prompt (structural extraction) in `src/llm/prompts/`
- [ ] Pass 2 prompt (synthesis with retrieved context)
- [ ] Pass 3 prompt (brief generation)
- [ ] Pipeline orchestrator in `src/pipelines/meeting-extraction/`
- [ ] Classification pipeline for project inference (uses projects.yaml +
      attendee matching + LLM fallback)
- [ ] Multi-memory output: one brief, N decisions, N action items, transcript
      chunks — all linked via source_id
- [ ] Confidence scoring on inferred fields
- [ ] Golden-test harness: run fixture -> compare to expected outputs
- [ ] Model routing: Qwen 14B on Windows Ollama for passes 1 and 3;
      OpenRouter (Haiku/Flash) for pass 2 synthesis (quality-critical)

Exit criteria: `npm run extract-meeting <fixture>` produces reasonable briefs,
action items, and decisions for 5+ fixture transcripts. Classification is
right or flagged with low confidence.

## Phase 4: Loom Adapter

Real meeting ingestion.

- [ ] Loom API client with auth
- [ ] Poll schedule for new recordings (every 15 min)
- [ ] Transcript fetch
- [ ] Attendee extraction from Loom metadata
- [ ] Route through meeting pipeline (Phase 3)
- [ ] Multi-memory ingestion into Engram
- [ ] Idempotency: re-running on same Loom ID updates, doesn't duplicate
- [ ] MCP tool: `catch_me_up_on_meeting`
- [ ] MCP tool: `list_unclassified_meetings` (review queue)

Exit criteria: Real Loom meeting ingested end-to-end, retrievable via Cortex
tools. Briefs readable, action items listed, decisions preserved.

## Phase 5: Confluence Adapter

- [x] Atlassian Cloud API v2 client with basic auth
- [x] Space inventory via `/spaces`, page listing via `/pages` filtered by since
- [x] Space-to-project rule-based classifier via `spaceToProject` config map
- [x] Page sync with `sort=-modified-date` for incremental pulls
- [x] Storage-format (XHTML) to markdown converter (headings, lists,
      inline emphasis, code blocks, entity decoding)
- [x] `@onenomad/przm-cortex-pipeline-doc` — chunk by heading hierarchy, one memory per
      chunk, shared across Notion/Jira/Google Drive/Obsidian
- [x] `cortex sync <adapter>` CLI for one-shot manual runs
- [x] 8 adapter tests, 7 pipeline tests
- [ ] LLM fallback classifier when no rule matches (deferred, needs
      LLMClassifier plumbing)
- [ ] Comment handling (comments are often where decisions actually live)
- [ ] Attachment handling (PDFs at minimum via pdf extraction; skip images
      for now)
- [ ] Scheduler integration (so sync runs on schedule, not just on demand)
- [ ] Page relationship graph (parents, children, links)
- [ ] Comment handling (comments are often where decisions actually live)
- [ ] Attachment handling (PDFs at minimum via pdf extraction; skip images
      for now)
- [ ] LLM-based project inference for pages in cross-project spaces
- [ ] Scheduled full-sync + incremental updates

Exit criteria: Every active page in every relevant Confluence space is
indexed and searchable via Cortex tools with correct project tagging.

## Phase 6: Pre-Meeting Briefs

- [x] Google Calendar OAuth flow and token storage (`@onenomad/przm-cortex-google-auth`
      + `cortex google-login`)
- [x] Upcoming events poller (`@onenomad/przm-cortex-adapter-google-calendar`)
- [x] Brief generation pipeline: queries Engram for relevant project context,
      past meetings in series, related docs, open action items
- [x] MCP tool: `upcoming_briefs`
- [x] Dashboard widget: `upcoming-briefs` (glanceable context, optional
      LLM synthesis)
- [ ] Delivery: markdown file to `<vault>/briefs/upcoming/` (deferred
      until Obsidian vault is set up)

Exit criteria: 30 minutes before a meeting, a brief is generated with
attendees, prior decisions, open threads, suggested questions. Met via
the MCP tool; dashboard surfaces a glanceable version.

## Phase 7: Daily Digest

- [x] MCP tool: `todays_digest` (queries Engram for today's meetings,
      decisions, action items; skips status-only content)
- [ ] End-of-day trigger / scheduled delivery
- [ ] Delivery channel (email? Slack DM to self? file in vault?)
- [ ] Weekly rollup variant

## Phase 8: Action Items

- [ ] Extraction already happens in Phase 3 meeting pipeline; this phase adds
      the tracking UX
- [ ] Status lifecycle: open, in-progress, done, dropped
- [ ] Unified queue across projects
- [ ] Due date handling (extracted where mentioned, blank otherwise)
- [ ] MCP tools: `my_action_items`, `mark_action_item_done`,
      `snooze_action_item`
- [ ] Integration with daily digest

## Phase 9: Obsidian Adapter

Deferred until you actually start keeping notes. When you're ready:

- [ ] Vault path configurable via env
- [ ] File watcher (chokidar) on vault
- [ ] Frontmatter parser for metadata overrides
- [ ] Path-to-project mapping rules
- [ ] Adapter shape: `fetch`, `transform`, `classify`, `ingest`
- [ ] Idempotent ingestion (source_id = file path + content hash)
- [ ] Tests with fixture vault

Exit criteria: Edit a markdown file in Obsidian, see the memory appear in
Engram within 60 seconds with correct project tagging.

## Phase 10: Bitbucket

- [ ] Repo inventory
- [ ] Clone/pull on schedule
- [ ] Tree-sitter chunking per language
- [ ] Dual-representation indexing (code + natural-language description)
- [ ] README/ADR priority handling (prose > code weighting)
- [ ] Commit message and PR description indexing
- [ ] `.indexignore` per repo

## Phase 11+: Future

- Slack ingestion
- Email integration
- Web dashboard for triage queue
- Mobile quick-capture
- Voice notes
- Commercial productization (separate track)

Track future ideas in `FUTURE.md` rather than cluttering this roadmap.

## Why This Order

Loom and Confluence are the author's primary work knowledge sources right
now. The author just started a new job, has no personal notes yet, but is in
many meetings and has access to existing Confluence documentation. Building
these first means the system delivers real value from the moment it runs,
instead of waiting for enough content to accumulate.

Obsidian moves down to Phase 9 because there's no existing content to index.
The author will build a note-taking habit over time; by then, the adapter
will be ready to plug in.

Calendar (pre-meeting briefs) comes before daily digest because walking into
a meeting already oriented is the single highest-leverage feature for an
ADHD-shaped brain. Digest is a nice-to-have by comparison.

Action items are broken out as Phase 8 even though extraction happens earlier
(in Phase 3). Phase 8 is the UX layer: queue management, status tracking,
integration with digest. Worth its own phase because the tracking loop is
what makes extracted items actually useful.

## Session Log

Record a one-line summary after each Claude Code session.

- 2026-04-21: Phase 1 scaffolding. Monorepo, 8 packages, ADR-010 for
  pluggable LLM providers, MCP skeleton wires end-to-end without adapters.
  Moved docs to `docs/` and aligned CLAUDE.md with ADR-008 monorepo layout.
- 2026-04-21: Phase 2 kickoff. Project/Person zod schemas, taxonomy loader
  with alias-normalized lookup, MCP tool framework, first two tools
  (`list_projects`, `get_project_context`). 29 tests total, live MCP
  server boots and advertises tools. Real Engram/Persona clients still
  stubbed.
- 2026-04-21: Phase 2 close. Real Engram + Persona MCP clients via stdio
  subprocesses. get_project_context queries Engram for recent_activity.
  SourceType + metadata schema expanded to include jira, linear, notion,
  google_drive, google_meet, github, teams. 32 tests total; live boot
  against @onenomad/engram-memory and @onenomad/persona-mcp confirmed.
- 2026-04-21: Phase 5 kickoff. First source adapter: @onenomad/przm-cortex-adapter-confluence
  (Atlassian Cloud v2, basic auth, storage→markdown converter, rule-based
  space→project classifier). New @onenomad/przm-cortex-pipeline-doc (heading-based
  chunker, shared across doc-shaped sources). `cortex sync` CLI runs one
  adapter's full fetch→transform→classify→pipeline→ingest cycle.
  Adapter registry now real, not stubbed. 48 tests total.
- 2026-04-22: Three more adapters. @onenomad/przm-cortex-adapter-jira (Cloud REST v3,
  basic auth shared with Confluence, ADF→markdown, rule-based
  projectKey→project). @onenomad/przm-cortex-adapter-notion (bearer auth, block-tree
  →markdown, databases+pages). @onenomad/przm-cortex-adapter-obsidian (filesystem
  walk, YAML frontmatter parser, path-prefix classifier with frontmatter
  override). All reuse pipeline-doc. 71 tests total.
- 2026-04-22: Native Postgres fallback (ADR-012). @onenomad/przm-cortex-memory-pgvector
  with HNSW + tsvector GIN fused via RRF; 18 unit tests mocking pg.
  Memory-backend factory picks engram by default, flips to pgvector when
  the primary health check fails.
- 2026-04-22: Push-based ingestion (ADR-013). stream() + webhook() on
  SourceAdapter; Obsidian chokidar watcher and GitHub webhooks ship as
  pilots. Single processItem() helper keeps cron/stream/webhook paths
  identical downstream.
- 2026-04-22: Docker + HTTP MCP transport. Multi-stage Dockerfile,
  compose with Engram + Persona sidecars, PRZM_CORTEX_MCP_TRANSPORT=stdio|http
  flag via StreamableHTTPServerTransport.
- 2026-04-22: PII hygiene foundation. docs/PRIVACY.md, .local.yaml
  override pattern for identifier-bearing config, grep-based
  pre-commit identifier scanner with allow-list, Node-based
  install-hooks.mjs that works on Windows/Mac/Linux without bash on
  PATH. Cross-platform docs pass across README and SETUP.md.
- 2026-04-22: Sprint A — wizard framework. WizardModule interface in
  @onenomad/przm-cortex-core; CLI runner via @inquirer/prompts in @onenomad/przm-cortex;
  atomic multi-file config-mutation service (cortex.local.yaml + .env
  + projects.local.yaml). First real wizard: @onenomad/przm-cortex-adapter-confluence
  with engagement/sub-brand/project/team context tuples.
- 2026-04-22: Sprint B — every module gets a wizard. Jira + Linear +
  Notion + Loom + Obsidian + GitHub + Bitbucket + Slack adapters; Ollama
  and OpenRouter providers; pgvector memory; webhooks receiver. Gmail
  + Google Calendar + Google Drive via a shared `cortex google-login`
  OAuth loopback. Category-aware config-mutation (ADR-014) routes
  writes to the right YAML section. Registry pin test catches
  regressions. 97 server tests + 3 google-auth tests green.
- 2026-04-22: Engram hooks redesigned (sibling repo, beta.10).
  engram_precompact_hook.sh auto-extracts a handoff from the Claude
  Code transcript and approves in one pass — no more block-then-approve
  loop. engram_stop_hook.sh writes a rolling session-checkpoint.json
  every turn so there's always a fresh lifeline on disk even if
  /compact never runs. readHandoff prefers timestamped handoffs over
  the rolling checkpoint.
