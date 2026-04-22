# Roadmap

Canonical build order and current state. Update after every meaningful session.

## Current Phase

**Phase 2: Project Taxonomy** — complete. Project/Person schemas, taxonomy
loader, first two MCP tools, and real Engram + Persona MCP clients are all
live. Cortex now spawns both upstream servers as subprocesses and wires
them into every tool's context. Next: Phase 3 meeting pipeline on fixtures.

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
- [x] `@cortex/core` — SourceAdapter, types, metadata contract
- [x] `@cortex/adapter-sdk` — BaseAdapter, retry, rate-limit, classifier stubs
- [x] `@cortex/pipeline-core` — Pipeline interface, stage runner
- [x] `@cortex/llm-core` — LLMProvider interface + LLMRouter (ADR-010)
- [x] `@cortex/llm-sdk` — BaseLLMProvider, OpenAI-compatible base, retry, http
- [x] `@cortex/provider-ollama` — real HTTP impl, unit tests
- [x] `@cortex/provider-openrouter` — real HTTP impl, unit tests
- [x] `@cortex/server` — MCP skeleton (zero tools), config loader, provider
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

- [x] `config/projects.yaml` schema (Zod) in `@cortex/core`
- [x] `config/people.yaml` schema (Zod) in `@cortex/core`
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

- [ ] Atlassian API client with auth
- [ ] Space inventory: discover what exists, what's active
- [ ] Space-to-project mapping in config
- [ ] Page sync: diff-based, track page versions
- [ ] Chunking by heading hierarchy, preserve heading path as metadata
- [ ] Page relationship graph (parents, children, links)
- [ ] Comment handling (comments are often where decisions actually live)
- [ ] Attachment handling (PDFs at minimum via pdf extraction; skip images
      for now)
- [ ] LLM-based project inference for pages in cross-project spaces
- [ ] Scheduled full-sync + incremental updates

Exit criteria: Every active page in every relevant Confluence space is
indexed and searchable via Cortex tools with correct project tagging.

## Phase 6: Pre-Meeting Briefs

- [ ] Google Calendar OAuth flow and token storage
- [ ] Upcoming events poller
- [ ] Brief generation pipeline: queries Engram for relevant project context,
      past meetings in series, related Confluence docs, open action items
- [ ] Delivery: markdown file to `<vault>/briefs/upcoming/` (will be useful
      once Obsidian is set up)
- [ ] MCP tool: `upcoming_briefs`

Exit criteria: 30 minutes before a meeting, a brief is generated with
attendees, prior decisions, open threads, suggested questions.

## Phase 7: Daily Digest

- [ ] End-of-day trigger
- [ ] Queries Engram for today's meetings, important activity, action items
- [ ] Prioritization logic: meetings where user was active, decisions vs
      status, active-project filter
- [ ] Delivery (email? Slack DM to self? file in vault?)
- [ ] MCP tool: `todays_digest`
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
