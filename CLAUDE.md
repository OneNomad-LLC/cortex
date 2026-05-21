# Cortex

A universal memory + on-prem company knowledge engine for AI agents.
Cortex is the **data plane**: storage, retrieval, ingestion adapters.
It runs with zero LLM. The **compute plane** (LLM-backed enrichment
— categorization, action extraction, summarization, entity tagging)
is delegated to the connected MCP client (Pyre, Claude Desktop,
custom agents) via the Cortex Enrichment Protocol, OR handled
in-process when an LLM provider is installed.

## What This Project Is

Cortex ingests from Loom, Confluence, Bitbucket, Obsidian, GitHub,
Slack, Notion, Gmail, Google Calendar/Drive, Jira, Linear. It
chunks content for retrieval and (optionally) runs it through
enrichment pipelines to produce structured outputs (briefs,
decisions, action items, references). It exposes all of this
through an MCP server that any MCP-aware agent (Claude Code,
Claude Desktop, Pyre) can query.

Cortex 0.2 dropped the personal-assistant framing. Time-relative
tools (`todays_digest`, `catch_me_up`, etc.) were replaced with
time-agnostic equivalents (`digest`, `summarize_recent`, etc.). The
LLM dependency was stripped — Cortex Core works without one and
delegates enrichment to the connected MCP client. See `MIGRATION.md`
and `docs/enrichment-protocol.md`.

## What This Project Is NOT

- Not a general-purpose memory system. Use a dedicated vector store or Engram for that.
- Not a communication-style learner.
- Not a replacement for Claude Code or Claude.ai. Those are the interfaces.

## Architecture

```
User (via Claude Code / Claude.ai)
            |
            v
       Cortex MCP  <- work-specific tools
            |
            v
      Source Adapters + Memory Backend
      (Loom, Confluence, Bitbucket,
       Obsidian, Calendar, pgvector)
```

Cortex exposes domain-specific tools (projects, meetings, briefs, action items).
Source adapters pull data from external services and route it through extraction
pipelines before ingesting into the configured memory backend with structured
metadata.

See `docs/ARCHITECTURE.md` for detailed component responsibilities and data flow.

## Core Concepts

**Project**: A unit of work with its own context, people, and content. Cortex
tracks a dozen+ concurrently. Defined in `config/projects.yaml`.

**Source**: Where content originated. One of: `loom`, `confluence`, `bitbucket`,
`obsidian`, `calendar`. Stored as metadata on every ingested memory.

**Type**: What kind of content. One of: `meeting`, `decision`, `action_item`,
`doc`, `code`, `note`, `brief`, `digest`.

**Brief**: A digestible summary designed for quick reading. Produced by the
meeting pipeline and the pre-meeting brief generator.

**Action Item**: A commitment extracted from a meeting or note. Tracked in a
unified queue across all projects. Owner, source, status, optional due date.

## Memory Metadata Contract

Every memory ingested into the memory backend must carry the following metadata:

```json
{
  "domain": "work",
  "source": "loom | confluence | bitbucket | obsidian | calendar",
  "source_id": "stable-id-from-source",
  "source_url": "https://...",
  "project": "project-slug | [project-a, project-b]",
  "type": "meeting | decision | action_item | doc | code | note | brief | digest",
  "people": ["person-slug", "..."],
  "date": "ISO 8601 timestamp",
  "confidence": "0.0 to 1.0 (for inferred fields like project tagging)"
}
```

This contract is load-bearing. Cortex's search tools filter on these fields.
Breaking it silently breaks retrieval quality.

See `schemas/memory-metadata.json` for the authoritative schema.

## Tech Stack

- **Language**: TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **LLM for pipelines**: pluggable provider layer. Toggle between local
  (Ollama) and BYOK cloud providers (OpenRouter, Anthropic, OpenAI, Google, or
  any OpenAI-compatible endpoint). Configurable per pipeline step, with a
  fallback chain. See ADR-004 and ADR-010.
- **Calendar**: Google Calendar API
- **Loom**: Loom API
- **Confluence/Bitbucket**: Atlassian APIs
- **Obsidian**: direct filesystem watch on the vault
- **Testing**: Vitest
- **Runtime**: Node 20+

## Repo Structure

Monorepo with pnpm workspaces. Each adapter, pipeline, and the server itself
is a separate package. See ADR-008.

```
cortex/
  CLAUDE.md                       # this file
  README.md
  package.json                    # workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  docker-compose.yml              # runs Cortex (+ optional pgvector/ollama profiles)
  .env.example

  config/
    cortex.yaml                   # which adapters are enabled
    projects.yaml                 # project taxonomy
    people.yaml                   # people-to-project mappings

  schemas/
    memory-metadata.json          # JSON schema for the metadata contract

  packages/
    core/                         # @onenomad/przm-cortex-core
      src/
        adapter.ts                # SourceAdapter interface
        types.ts                  # NormalizedItem, ClassifiedItem, enums
        context.ts                # AdapterContext
        capabilities.ts           # AdapterCapabilities

    adapter-sdk/                  # @onenomad/przm-cortex-adapter-sdk
      src/
        base-adapter.ts           # abstract base class
        retry.ts
        rate-limit.ts
        idempotency.ts            # source_id dedup helpers
        classifier-llm.ts         # default LLM classifier
        classifier-rule.ts        # rule-based classifier

    pipeline-core/                # @onenomad/przm-cortex-pipeline-core
      src/
        pipeline.ts               # generic pipeline framework

    llm-core/                     # @onenomad/przm-cortex-llm-core
      src/
        provider.ts               # LLMProvider interface
        router.ts                 # per-task routing + fallback chain
        types.ts                  # LLMRequest, LLMResponse, TaskPurpose

    llm-sdk/                      # @onenomad/przm-cortex-llm-sdk
      src/
        base-provider.ts
        openai-compatible.ts      # reused by most cloud providers
        retry.ts
        rate-limit.ts

    provider-ollama/              # @onenomad/przm-cortex-provider-ollama
    provider-openrouter/          # @onenomad/przm-cortex-provider-openrouter
    provider-anthropic/           # (future)
    provider-openai/              # (future)
    provider-google/              # (future)

    pipeline-meeting/             # @onenomad/przm-cortex-pipeline-meeting (Phase 3)
      src/
        prompts/                  # all prompts as .md files for review
        ...

    pipeline-doc/                 # @onenomad/przm-cortex-pipeline-doc (Phase 5)
    pipeline-code/                # @onenomad/przm-cortex-pipeline-code (Phase 10)

    adapter-loom/                 # @onenomad/przm-cortex-adapter-loom (Phase 4)
    adapter-confluence/           # @onenomad/przm-cortex-adapter-confluence (Phase 5)
    adapter-calendar/             # @onenomad/przm-cortex-adapter-calendar (Phase 6)
    adapter-obsidian/             # @onenomad/przm-cortex-adapter-obsidian (Phase 9)
    adapter-bitbucket/            # @onenomad/przm-cortex-adapter-bitbucket (Phase 10)

    server/                       # @onenomad/przm-cortex (the CLI + MCP server)
      src/
        mcp/
          server.ts               # MCP server entry
          tools/                  # one file per tool
        clients/
          memory.ts               # typed client for memory backend
        registry/
          adapters.ts             # adapter discovery and lifecycle
          providers.ts            # LLM provider discovery and wiring
        scheduler.ts              # runs adapters on their schedules

  docs/
    ARCHITECTURE.md
    ROADMAP.md
    DECISIONS.md                  # ADR-style decision log
    SETUP.md
    HOSTING.md
```

## Conventions

**Prompts live as markdown files in `packages/pipeline-*/src/prompts/`.** Never
inline prompts in code. Makes them reviewable, diffable, and improvable without
touching logic. See ADR-007.

**Every adapter has the same shape**: `fetch`, `transform`, `classify`,
`ingest`. Don't invent new structures per source.

**Every ingestion path is idempotent.** Re-running an adapter on the same
content updates existing memories, never duplicates. Use `source_id` as the
dedup key via the memory backend's duplicate detection.

**Secrets live in `.env`, never in config files.** Config files are checked
in; `.env` is not. `.env.example` shows required variables.

**One MCP tool per file.** Tools are independently testable.

**Tests alongside code where practical.** Integration tests that hit real
storage backends use docker-compose for setup.

## Build Order

See `docs/ROADMAP.md` for the canonical, up-to-date order and current state.
Summary:

1. Monorepo foundation, memory backend, Ollama + OpenRouter clients, empty MCP server
2. Project taxonomy (config + `list_projects` + `get_project_context` tools)
3. Meeting pipeline on fixtures (3-pass: structural -> synthesis -> brief)
4. Loom adapter (applies pipeline to real data)
5. Confluence adapter
6. Pre-meeting briefs (Google Calendar)
7. Daily digest
8. Action item tracking UX
9. Obsidian adapter (deferred — no notes yet)
10. Bitbucket adapter

Each step should be independently useful. Don't build #10 before #5 works.

## What Claude Code Should Not Do

- Do not commit `.env`, API keys, or any secrets.
- Do not modify the memory metadata contract without updating every adapter
  and this file.
- Do not use prompts inline; keep them in `packages/pipeline-*/src/prompts/`.
- Do not skip tests on ingestion adapters. They fail silently and corrupt
  retrieval quality.
- Do not guess at project or people taxonomy. Read `config/projects.yaml`
  and `config/people.yaml`. If missing info, ask.

## When Claude Code Starts a Session

1. Read this file (CLAUDE.md).
2. Read `docs/ROADMAP.md` for current state.
3. Read `docs/DECISIONS.md` for prior architectural decisions.
4. If working on a specific source adapter, read that adapter's README.
5. Ask what task to work on. Don't assume continuity from last session.

## Owner / Context

Single-user project, private repo. Author has ADHD and works across a dozen
concurrent projects at a new job. The system is the author's daily driver,
so reliability and low cognitive overhead are paramount. Features that require
constant manual curation will not be used and therefore should not be built.
