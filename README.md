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

Two MCP tools live (`list_projects`, `get_project_context`). **Six
source adapters** shipped — Confluence, Jira, Linear, Loom, Notion,
Obsidian. **Two pipelines** shipped — `@cortex/pipeline-doc` (prose →
chunked memories) and `@cortex/pipeline-meeting` (3-pass extraction:
structural → synthesis → brief, prompts as `.md` files). 93 tests.
`cortex sync <adapter>` runs a full ingestion cycle on demand with the
LLM router wired into the pipeline context. See
[`docs/ROADMAP.md`](docs/ROADMAP.md) for what's next.

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
cortex smoke                # live probe of every enabled LLM provider
cortex sync <adapter>       # run one adapter's full ingestion cycle
  --since=ISO                 only items updated after this date
  --limit=N                   cap items processed
  --dry-run                   don't write to Engram
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
| `@cortex/adapter-google-calendar` | planned | Google OAuth | `pipeline-event` |
| `@cortex/adapter-google-drive` | planned | Google OAuth | `pipeline-doc` |
| `@cortex/adapter-gmail` | planned | Google OAuth | `pipeline-email` |
| `@cortex/adapter-bitbucket` | planned | Atlassian token | `pipeline-code` |
| `@cortex/adapter-github` | planned | GitHub PAT | `pipeline-code` |
| `@cortex/adapter-slack` | planned | Slack token | `pipeline-conversation` |

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
`config/cortex.yaml > llm.tasks`. See [ADR-010](docs/DECISIONS.md).

Current provider packages:

- `@cortex/provider-ollama` — local (Ollama, any model it supports; `think: false` by default)
- `@cortex/provider-openrouter` — BYOK cloud aggregator

Future: `@cortex/provider-anthropic`, `@cortex/provider-openai`,
`@cortex/provider-google` for direct-provider BYOK.

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

Reload Claude Code. `cortex` should appear in `/mcp` with the two tools
currently shipped.

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
       │     ├── @cortex/adapter-confluence ✅
       │     ├── @cortex/adapter-jira       ✅
       │     ├── @cortex/adapter-linear     ✅
       │     ├── @cortex/adapter-loom       ✅
       │     ├── @cortex/adapter-notion     ✅
       │     ├── @cortex/adapter-obsidian   ✅
       │     └── (… Google / GitHub / Bitbucket / Slack / …)
       │
       ├── Pipelines             (shape-specific, reusable)
       │     ├── @cortex/pipeline-doc       ✅  (prose → chunked memories)
       │     ├── @cortex/pipeline-meeting   ✅  (3-pass: structural → synthesis → brief)
       │     └── (future: pipeline-code, pipeline-conversation, pipeline-event)
       │
       └── Upstream MCP clients
             ├── @onenomad/engram-memory    (spawned as stdio subprocess)
             └── @onenomad/persona-mcp      (spawned as stdio subprocess)
```

Every adapter implements the same `SourceAdapter` contract. Every LLM
provider implements the same `LLMProvider` contract. Every pipeline
implements the same `Pipeline` contract. All three layers are loaded
from config at startup, so swapping or disabling any piece is a config
edit — not a code change.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full story
including the 3-pass meeting extraction pipeline, classification
strategy, and failure-mode handling.

## Development

```bash
pnpm install              # install all workspace deps
pnpm typecheck            # tsc --build across the monorepo
pnpm test                 # unit tests (71 and counting)
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
