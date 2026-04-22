# Cortex

Work-knowledge MCP server. Unifies docs (Confluence, Notion), tickets
(Jira), personal notes (Obsidian) — and later meetings, code, email,
and chat — into a single searchable layer Claude Code and Claude.ai
can query.

Built as an orchestration layer on top of two standalone MCP servers:

- [**@onenomad/engram-memory**](https://www.npmjs.com/package/@onenomad/engram-memory) — memory, hybrid search, knowledge graph
- [**@onenomad/persona-mcp**](https://www.npmjs.com/package/@onenomad/persona-mcp) — evolving personality, style signals

Cortex adds domain-specific MCP tools (projects, meetings, briefs,
action items, research) and modular source adapters. Every adapter
and LLM provider is a standalone package — install only what you use.

## Status

**Ten MCP tools** live: `list_projects`, `get_project_context`,
`catch_me_up`, `catch_me_up_on_meeting`, `my_action_items`,
`upcoming_briefs`, `research`, `approve_research` (draft / in_review /
approved / revoked), `list_unclassified` (classifier review queue),
and `todays_digest` (composite morning view). **Twelve source
adapters** shipped — Confluence, Jira, Linear, Loom, Notion, Obsidian,
Google Calendar, Google Drive, Gmail, Bitbucket, GitHub, Slack. **Five
pipelines** shipped — doc, meeting (3-pass), code, conversation, and
research (two-pass: extract → brief). **Pluggable memory backend** —
Engram primary, `@cortex/memory-pgvector` as a native
hybrid-search fallback (Postgres + pgvector + tsvector, fused via RRF).
**Cron-based scheduler** runs every enabled adapter on its schedule
inside `cortex start`, reporting per-adapter run stats to a heartbeat
file readable via `cortex status`. **Push-based ingestion** — adapters
can implement `stream()` (Obsidian file-watcher today) or `webhook()`
(GitHub push events today) for near-real-time updates alongside the
cron path. **LLM classifier fallback** wired
into every adapter. **Memory governance metadata** — `trust`,
`sensitivity`, `status`, `trace_id` stamped on every ingest. 228 tests.

## Install

```bash
# Global install (once published)
npm install -g @onenomad/cortex

# Or develop locally
git clone https://github.com/mattstvartak/cortex.git
cd cortex
pnpm install
```

## First-run setup

Run the interactive wizard. It detects whether Engram and Persona are
installed globally, offers to install the missing ones, auto-installs
local Ollama if you pick it, and writes `.env` + `config/cortex.yaml`.

```bash
cortex init
```

The wizard:

1. Probes `persona-mcp` and `engram-memory` on PATH; `npm install -g`s any missing.
2. If you pick Ollama local: detects `ollama`, offers to auto-install
   (winget / brew / shell script), waits for the daemon, pulls the
   chosen model.
3. Prompts for LLM providers, API keys, host.
4. Writes config (backs up any existing versions with `.bak.<ts>`).
5. Runs a live smoke test.

## Commands

```bash
cortex init                 # interactive setup wizard
cortex start                # boot the MCP server over stdio
cortex status               # daemon heartbeat (uptime, per-adapter stats)
cortex smoke                # live probe of every enabled LLM provider
cortex sync <adapter>       # run one adapter's full ingestion cycle
  --since=ISO                 only items updated after this date
  --limit=N                   cap items processed
  --dry-run                   don't write to memory
cortex help
```

## Source adapters

| Adapter | Status | Auth | Reuses |
|---|---|---|---|
| `@cortex/adapter-confluence` | ✅ shipped | Atlassian token | `pipeline-doc` |
| `@cortex/adapter-jira` | ✅ shipped | Atlassian token (same) | `pipeline-doc` |
| `@cortex/adapter-linear` | ✅ shipped | `LINEAR_API_KEY` | `pipeline-doc` |
| `@cortex/adapter-loom` | ✅ shipped | `LOOM_API_KEY` | `pipeline-meeting` |
| `@cortex/adapter-notion` | ✅ shipped | `NOTION_API_KEY` | `pipeline-doc` |
| `@cortex/adapter-obsidian` | ✅ shipped | (filesystem) | `pipeline-doc` |
| `@cortex/adapter-google-calendar` | ✅ shipped | Google OAuth | `pipeline-doc` |
| `@cortex/adapter-google-drive` | ✅ shipped | Google OAuth | `pipeline-doc` |
| `@cortex/adapter-gmail` | ✅ shipped | Google OAuth | `pipeline-doc` |
| `@cortex/adapter-bitbucket` | ✅ shipped | Atlassian token | `pipeline-code` |
| `@cortex/adapter-github` | ✅ shipped | `GITHUB_TOKEN` | `pipeline-code` |
| `@cortex/adapter-slack` | ✅ shipped | `SLACK_BOT_TOKEN` | `pipeline-conversation` |

Enabling an adapter is a three-step flip:

```yaml
# config/cortex.yaml
adapters:
  confluence:
    enabled: true            # 1. flip on
    config:
      workspace: "yourco"    # 2. tell it where
      spaces: ["ENG"]
      spaceToProject:
        ENG: engineering
```

```bash
# .env — 3. credentials
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=...
```

Then `cortex sync confluence --dry-run --limit=5` to preview, drop the
flags to actually ingest.

## LLM providers

Pluggable — toggle between local Ollama, OpenRouter, or BYOK direct
providers (Anthropic/OpenAI/Google) per-task via
`config/cortex.yaml > llm.tasks`. Task purposes: `default`,
`structural`, `synthesis`, `brief`, `classify`, `embed`. See
[ADR-010](docs/DECISIONS.md).

Current provider packages:

- `@cortex/provider-ollama` — local (Ollama, any model it supports;
  `think: false` by default; `/api/embed` for embedding tasks)
- `@cortex/provider-openrouter` — BYOK cloud aggregator

Future: `@cortex/provider-anthropic`, `@cortex/provider-openai`,
`@cortex/provider-google` for direct-provider BYOK.

## Real-time ingestion

Adapters can push new items into memory as they arrive, alongside the
cron schedule. Two opt-in paths:

- **`stream()`** — long-running iterator the server subscribes to at
  boot. Obsidian uses this with a chokidar filesystem watcher; new
  notes land in memory within a second of save.
- **`webhook()`** — the server spins up an HTTP receiver when
  `webhooks.enabled: true` in `cortex.yaml` and at least one adapter
  declares a handler. GitHub push events are the pilot; HMAC-SHA256
  verified via `GITHUB_WEBHOOK_SECRET`.

```yaml
webhooks:
  enabled: true
  port: 4040
```

The port binds to `0.0.0.0`; exposing it publicly is an operator
concern — Tailscale Funnel, a reverse proxy, or ngrok depending on
deployment shape. See [ADR-013](docs/DECISIONS.md).

## Memory backend

Engram is the primary memory store. For deployments without Engram —
or for a safety net when the Engram subprocess is down —
`@cortex/memory-pgvector` provides a native hybrid-search backend
(Postgres + `pgvector` HNSW + `tsvector` GIN, fused via reciprocal
rank fusion). Both expose the same ingest/search/health contract, so
tools don't care which one answers.

Enable it in `config/cortex.yaml`:

```yaml
memory:
  primary: engram
  fallback: pgvector
  pgvector:
    connectionString: "${POSTGRES_URL}"
    embeddingDim: 768          # must match the model bound to llm.tasks.embed
```

At boot Cortex health-checks the primary; if it's unreachable the
whole session runs on the fallback (logged; no runtime per-call
switch). See [ADR-012](docs/DECISIONS.md).

## Connect to Claude Code

Add this to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "cortex",
      "args": ["start"]
    }
  }
}
```

Reload Claude Code. `cortex` should appear in `/mcp` with all ten
tools currently shipped.

## Architecture

```
AI Client (Claude Code / Claude.ai)
       │ MCP
       ▼
Cortex MCP server
       ├── MCP tools             list_projects, get_project_context, …
       │
       ├── LLM provider layer    (pluggable, per-task routing)
       │     ├── @cortex/provider-ollama
       │     ├── @cortex/provider-openrouter
       │     └── (future: anthropic, openai, google)
       │
       ├── Source adapters       (modular, one package each)
       │     ├── @cortex/adapter-confluence        ✅
       │     ├── @cortex/adapter-jira              ✅
       │     ├── @cortex/adapter-linear            ✅
       │     ├── @cortex/adapter-loom              ✅
       │     ├── @cortex/adapter-notion            ✅
       │     ├── @cortex/adapter-obsidian          ✅
       │     ├── @cortex/adapter-bitbucket         ✅
       │     ├── @cortex/adapter-github            ✅
       │     ├── @cortex/adapter-slack             ✅
       │     ├── @cortex/adapter-google-calendar   ✅  ┐
       │     ├── @cortex/adapter-google-drive      ✅  ├─ share @cortex/google-auth
       │     └── @cortex/adapter-gmail             ✅  ┘
       │
       ├── Pipelines             (shape-specific, reusable)
       │     ├── @cortex/pipeline-doc           ✅  (prose → chunked memories)
       │     ├── @cortex/pipeline-meeting       ✅  (3-pass: structural → synthesis → brief)
       │     ├── @cortex/pipeline-code          ✅  (per-file, language-aware chunking)
       │     ├── @cortex/pipeline-conversation  ✅  (chat threads → transcript + quotes)
       │     └── @cortex/pipeline-research      ✅  (topic → reference brief + findings)
       │
       ├── Memory backend        (pluggable — engram or pgvector)
       │     ├── @onenomad/engram-memory     (spawned as stdio subprocess — primary)
       │     └── @cortex/memory-pgvector     (Postgres + pgvector — native fallback)
       │
       └── Upstream MCP clients
             └── @onenomad/persona-mcp       (spawned as stdio subprocess)
```

Every adapter implements the same `SourceAdapter` contract. Every LLM
provider implements the same `LLMProvider` contract. Every pipeline
implements the same `Pipeline` contract. Engram and pgvector both
implement the same `MemoryBackend` contract. All four layers are
loaded from config at startup, so swapping or disabling any piece is
a config edit — not a code change.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full story
including the 3-pass meeting extraction pipeline, classification
strategy, and failure-mode handling.

## Development

```bash
pnpm install              # install all workspace deps
pnpm typecheck            # tsc --build across the monorepo
pnpm test                 # unit tests (228 and counting)
pnpm dev                  # run `cortex start` in watch mode
pnpm smoke                # live provider smoke test
```

Workspace layout is described in [CLAUDE.md](CLAUDE.md). Architectural
decisions that shaped this structure are in
[`docs/DECISIONS.md`](docs/DECISIONS.md) (ADRs).

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — project overview and guardrails
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — detailed architecture
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phases and current state
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — ADR log
- [`docs/SETUP.md`](docs/SETUP.md) — manual prerequisites (machines, Ollama, Tailscale)
- [`docs/HOSTING.md`](docs/HOSTING.md) — where this runs in production

## License

Private project. Not for redistribution. Future commercial licensing TBD.
