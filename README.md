# Cortex

**Universal memory + on-prem company knowledge engine for AI agents.**

Cortex unifies docs (Confluence, Notion), tickets (Jira), meetings
(Loom), code (GitHub, Bitbucket), email (Gmail, Outlook), chat
(Slack), notes (Obsidian) — and anything else with an adapter — into
a single searchable layer that any MCP-aware agent can query.

Cortex 0.2 is positioned as the **data plane**: it stores raw
content and exposes retrieval. The **compute plane** (LLM-backed
enrichment — categorization, action extraction, summarization,
entity tagging) is delegated to the connected MCP client via the
[Cortex Enrichment Protocol](docs/enrichment-protocol.md). Cortex
runs with zero LLM. Bring your own — locally or via an MCP client
like Pyre, Claude Desktop, or any custom agent.

Built as an orchestration layer on top of two standalone MCP servers:

- [**@onenomad/engram-memory**](https://www.npmjs.com/package/@onenomad/engram-memory) — memory, hybrid search, knowledge graph
- [**@onenomad/persona-mcp**](https://www.npmjs.com/package/@onenomad/persona-mcp) — evolving personality, style signals

Cortex adds domain-specific MCP tools (projects, meetings, briefs,
action items, research) and modular source adapters. Every adapter
and LLM provider is a standalone package — install only what you use.

## Two install shapes

```
                     ┌──────────────────────────────────┐
                     │  Cortex Core (data plane)        │
                     │  storage + retrieval + adapters  │
                     │  — runs with NO LLM —            │
                     └──────────────────────────────────┘
                                    │
        ┌───────────────────────────┴──────────────────────────┐
        ▼                                                      ▼
┌─────────────────────────┐                ┌─────────────────────────────────┐
│ Standalone with LLM     │                │ Connected to MCP client         │
│                         │                │                                 │
│ - install Ollama or     │                │ - any MCP client (Pyre, Claude  │
│   OpenRouter provider   │                │   Desktop, custom agent)        │
│ - in-process enrichment │                │ - enrichment via Cortex         │
│                         │                │   Enrichment Protocol (queue)   │
│ - good for self-hosted  │                │ - good for distributed setups   │
│   single-node           │                │   and on-prem company use       │
└─────────────────────────┘                └─────────────────────────────────┘
```

Without enrichment, search and retrieval still work against raw
ingested content. Connect an enrichment provider later and re-run
the adapter to backfill the structured layer.

## Documentation

- **[docs/MCP-STACK.md](docs/MCP-STACK.md)** — how Cortex, Engram,
  Persona, and Synapse fit together (and which ones you actually need).
- **[docs/USING.md](docs/USING.md)** — day-in-the-life: what Cortex does
  for you in the morning, during the day, and at end of day.
- **[docs/SETUP.md](docs/SETUP.md)** — full from-scratch installation,
  environment variables, OAuth flows.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — internal data plane,
  pipelines, adapter contract.
- **[docs/DECISIONS.md](docs/DECISIONS.md)** — ADR log.

## Status

**MCP tool surface** (workspace-scoped unless noted):

- *Knowledge:* `list_projects`, `get_project_context`,
  `summarize_recent`, `summarize_meeting`, `pending_action_items`,
  `list_unclassified`, `digest`, `search_related`
- *Enrichment protocol* (Cortex 0.2):
  `pending_enrichment_requests`, `submit_enrichment_result` — for
  connected MCP clients to act as Cortex's enrichment provider when
  no local LLM is configured. See [docs/enrichment-protocol.md](docs/enrichment-protocol.md).
- *Notes:* `note_create`, `note_update`, `note_delete`, `note_list` —
  markdown notes saved to your Obsidian vault under
  `<vault>/cortex-notes/`, ingested into Engram automatically
- *Identity:* `get_user_identity`, `update_user_identity`,
  `get_job_profile`, `set_job_profile`, `update_job_profile` (job
  profile is private-module; optional)
- *Session bridge:* `leave_session_handoff`, `read_session_handoffs`,
  `resolve_session_handoff` — hand a conversation off between Claude
  Desktop, Claude Code, and Claude for Chrome via Cortex as the bus
- *Workspaces:* `list_workspaces`, `current_workspace`,
  `switch_workspace`, `add_workspace`, `set_session_workspace`,
  `get_session_workspace`

**Workspaces.** One Cortex install serves multiple jobs or contexts
(e.g. employer + personal) with fully isolated config + .env + memory
state under `~/.cortex/workspaces/<slug>/`. Manage from the terminal
(`cortex workspace *`), from Claude via MCP tools, or from the
dashboard dropdown.

**Local dashboard.** `@onenomad/cortex-dashboard` (Next.js 15 + shadcn/ui)
provides:

- **Today timeline (`/`)** — chronological "what needs your attention
  right now" view: overdue items, next 2 hours, rest of day, EOD
  capture prompt after 16:00 local
- **Notes (`/notes`)** — TipTap markdown editor; saves to your
  Obsidian vault and ingests via the obsidian adapter
- **Search (`/search`)** — semantic + keyword retrieval via
  `search_related`, with type / source / project / since filters
- **Widgets (`/widgets`)** — the original grid: priorities,
  today-meetings, upcoming-briefs, my-action-items, recent-decisions,
  recent-activity, code-activity, who-knows
- **Settings (`/settings`)** — Identity (name, role, job profile),
  Workspaces, Projects + People YAML editors, raw config
- **MCP console (`/mcp`)** — invoke any registered MCP tool form-driven
- **Adapters / Providers / Modules** — wizard-driven config forms
- **Status / Logs** — live heartbeat and tail

Layout is YAML-driven with delivery/developer/custom role presets.
Dashboard is optional — off by default (`api.enabled: false`).

**Twelve source adapters** — Confluence, Jira, Linear, Loom, Notion,
Obsidian, Google Calendar, Google Drive, Gmail, Bitbucket, GitHub,
Slack. Atlassian + Google Calendar adapters implement
`discoverProjects` so `cortex add bitbucket` (etc.) offers to
auto-import discovered resources as projects without hand-typing
slugs. Manual transcript import for sources without API access:
`cortex import meeting <file>` runs .vtt / .srt / .md through the
meeting pipeline.

**Five pipelines** — doc, meeting (3-pass), code, conversation,
research (two-pass: extract → brief).

**Pluggable memory backend** — Engram primary, `@onenomad/cortex-memory-pgvector`
as a native hybrid-search fallback (Postgres + pgvector + tsvector,
fused via RRF). `@onenomad/cortex-memory-remote` skeleton ready for federated
personal-local + shared-team Engram per ADR-016.

**Cron-based scheduler** runs every enabled adapter on its schedule
inside `cortex start`, reporting per-adapter run stats to a heartbeat
file readable via `cortex status`. **Push-based ingestion** — adapters
can implement `stream()` (Obsidian file-watcher) or `webhook()`
(GitHub push events) for near-real-time updates alongside the cron
path. **LLM classifier fallback** wired into every adapter.

**Active notifications.** Cortex's notification dispatcher fires three
recurring triggers via Slack DM:

- **Morning brief** at 08:00 local — today's meetings, priority
  action items, overnight signals
- **Pre-meeting brief** T-30 minutes per calendar event — attendees,
  prior context, open commitments, suggested questions
- **End-of-day capture** at 17:00 local — open commitments to
  resolve, snooze, or roll forward

Configured via `~/.cortex/workspaces/<slug>/notifications.yaml`. Manual
fire from the CLI: `cortex notify <morning|pre-meeting|eod>
[--dry-run]`.

**SQLite read-model cache.** Dashboard widgets are cached in a
per-host SQLite file so dashboard load drops from 2-5s to sub-100ms
(ADR-019 Phase 1). Refresher runs in-process on a per-widget cadence;
stale-while-revalidate semantics are Phase 2.

**Pre-flight diagnostic.** `cortex doctor [--connect]` verifies
config, secrets, tokens, and taxonomy before boot; `--connect` also
live-probes Engram + Postgres. **Memory governance metadata** —
`trust`, `sensitivity`, `status`, `trace_id` stamped on every ingest.

## Prerequisites

Cortex runs on Windows, macOS, and Linux. You need:

| Tool | Min version | Install |
|---|---|---|
| **Node.js** | 20 LTS | Windows: `winget install OpenJS.NodeJS.LTS` · macOS: `brew install node@20` · Linux: `nvm install 20` (or distro package) |
| **pnpm** | 9 | `npm install -g pnpm` on every OS |
| **Git** | 2.30+ | Windows: `winget install Git.Git` (bundles Git Bash, used internally by hooks) · macOS: `brew install git` · Linux: `apt install git` / `pacman -S git` |
| **Docker** *(optional)* | Latest | Only needed for the compose deployment path (pgvector/ollama profiles). Windows/macOS via Docker Desktop · Linux via `docker.io` / `docker-ce` |

**Platform note for Windows.** The project's dev scripts use Node cross-platform wrappers; you don't need bash on your PATH. Git for Windows ships with bash for the git-hook runtime, which is all the hooks need.

## Install

Windows (PowerShell):

```powershell
# Global install (once published)
npm install -g @onenomad/cortex

# Or develop locally (this is a private repo; access is provisioned)
git clone <your-cortex-repo-url>
Set-Location cortex
pnpm install
```

macOS / Linux (bash / zsh):

```bash
# Global install (once published)
npm install -g @onenomad/cortex

# Or develop locally (this is a private repo; access is provisioned)
git clone <your-cortex-repo-url>
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
cortex init                      # interactive setup wizard
cortex start                     # boot the MCP server over stdio
cortex status                    # daemon heartbeat (uptime, per-adapter stats)
cortex doctor [--connect]        # pre-flight checks; --connect live-probes
cortex smoke                     # live probe of every enabled LLM provider
cortex dashboard [--port N]      # launch the Next.js web dashboard
cortex sync <adapter>            # run one adapter's full ingestion cycle
  --since=ISO                      only items updated after this date
  --limit=N                        cap items processed
  --dry-run                        don't write to memory
cortex import meeting <file>     # run a transcript through pipeline-meeting
  --project=<slug> --date=<ISO>
  --attendees=<csv> --source-url=<url>
  --dry-run

cortex modules                   # list installable module wizards
cortex add <module>              # enable an adapter/provider via wizard
cortex add projects              # auto-discover + import projects
cortex configure <module>        # re-run a wizard with current values
cortex disable <module>          # turn off a configured module

cortex workspace list            # every workspace, * marks active
cortex workspace current         # print active slug
cortex workspace add <slug>      # create a new workspace
  [--from <path>]                  seed with an existing config dir
cortex workspace switch <slug>
cortex workspace remove <slug> --yes
cortex workspace rename <old> <new>

cortex google-login              # OAuth flow for gmail/calendar/drive
cortex help
```

## Source adapters

| Adapter | Status | Auth | Reuses |
|---|---|---|---|
| `@onenomad/cortex-adapter-confluence` | ✅ shipped | Atlassian token | `pipeline-doc` |
| `@onenomad/cortex-adapter-jira` | ✅ shipped | Atlassian token (same) | `pipeline-doc` |
| `@onenomad/cortex-adapter-linear` | ✅ shipped | `LINEAR_API_KEY` | `pipeline-doc` |
| `@onenomad/cortex-adapter-loom` | ✅ shipped | `LOOM_API_KEY` | `pipeline-meeting` |
| `@onenomad/cortex-adapter-notion` | ✅ shipped | `NOTION_API_KEY` | `pipeline-doc` |
| `@onenomad/cortex-adapter-obsidian` | ✅ shipped | (filesystem) | `pipeline-doc` |
| `@onenomad/cortex-adapter-google-calendar` | ✅ shipped | Google OAuth | `pipeline-doc` |
| `@onenomad/cortex-adapter-google-drive` | ✅ shipped | Google OAuth | `pipeline-doc` |
| `@onenomad/cortex-adapter-gmail` | ✅ shipped | Google OAuth | `pipeline-doc` |
| `@onenomad/cortex-adapter-bitbucket` | ✅ shipped | Atlassian token | `pipeline-code` |
| `@onenomad/cortex-adapter-github` | ✅ shipped | `GITHUB_TOKEN` | `pipeline-code` |
| `@onenomad/cortex-adapter-slack` | ✅ shipped | `SLACK_BOT_TOKEN` | `pipeline-conversation` |

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

## Dashboard

Local Next.js 15 app over an HTTP sidecar that `cortex start` boots
when `api.enabled: true`. Per-user, localhost-only by default.
Widgets are server-rendered React components that hit the sidecar's
widget endpoints; layout is YAML-driven.

```yaml
# config/cortex.local.yaml (gitignored)
api:
  enabled: true
  host: "127.0.0.1"
  port: 4141
```

```yaml
# config/dashboard.yaml — role preset + overrides
role: delivery         # delivery | developer | custom
widgets: []            # override or append preset entries
```

Run it:

```bash
cortex start           # terminal 1: MCP + sidecar
cortex dashboard       # terminal 2: Next.js dev server on :3030
```

The header pill shows the active workspace and doubles as a switcher.
Adding a widget is two files (server handler + React component) per
ADR-015.

## Workspaces

One install, many contexts. Each workspace gets its own `cortex.yaml`,
`projects.yaml`, `people.yaml`, `dashboard.yaml`, and `.env`, stored
at `~/.cortex/workspaces/<slug>/`. Active workspace lives in
`~/.cortex/state.json`; `resolveConfigPath` reads it before falling
back to walk-up / home / cwd.

```bash
# Adopt the repo's current config as your first workspace
cortex workspace add elevate --from .

# Create a blank one for personal projects and switch
cortex workspace add one-nomad
cortex workspace switch one-nomad
cortex init            # fresh LLM/adapter setup inside one-nomad

# Later
cortex workspace switch elevate
```

Manage from Claude instead of the terminal:

```
list_workspaces()
current_workspace()
switch_workspace({ slug: "one-nomad" })
add_workspace({ slug: "personal", fromPath: "..." })
```

Or from the dashboard: click the blue workspace pill in the header.

**Restart note.** Switching flips `state.json` immediately, but a
running `cortex start` still holds the previous workspace's Engram
subprocess + config in memory. Restart the daemon (and refresh the
dashboard) to load the new workspace's data. MCP tool responses and
the dashboard UI both surface this warning inline.

Destructive ops (`remove`, `rename`) stay terminal-only to avoid
accidental deletion via a chat tool.

## Session handoffs

Bridge conversations across Claude surfaces. At the end of a Claude
Code session, leave a handoff. The next morning in Claude Desktop,
read open handoffs to pick up where you left off.

```
leave_session_handoff({
  summary: "Stuck debugging sync.ts race condition",
  nextSteps: ["Add jitter to retry backoff"],
  fileRefs: ["packages/server/src/sync.ts:142"],
  platform: "claude-code"
})

read_session_handoffs()           # returns open handoffs newest-first
resolve_session_handoff({ id, note: "Shipped in PR #42" })
```

Stored as regular Engram memories with `type: "session_handoff"` —
searchable alongside everything else.

## LLM providers (optional)

Cortex 0.2 — provider packages are **optional**. Cortex Core runs
without one; enrichment is delegated to the connected MCP client
via the [Cortex Enrichment Protocol](docs/enrichment-protocol.md).

If you want in-process enrichment, install one or more providers
and toggle them per-task in `config/cortex.yaml > llm.tasks`. Task
purposes: `default`, `structural`, `synthesis`, `brief`, `classify`,
`embed`. See [ADR-010](docs/DECISIONS.md).

Provider packages (all optional):

- `@onenomad/cortex-provider-ollama` — local (Ollama, any model it supports;
  `think: false` by default; `/api/embed` for embedding tasks)
- `@onenomad/cortex-provider-openrouter` — BYOK cloud aggregator

Future: `@onenomad/cortex-provider-anthropic`, `@onenomad/cortex-provider-openai`,
`@onenomad/cortex-provider-google` for direct-provider BYOK.

### Enrichment via MCP client (no local LLM)

When no provider is installed Cortex boots in queue mode. A
connected MCP client (Pyre, Claude Desktop, any agent that
implements the protocol) drains the queue with
`pending_enrichment_requests` and posts results back via
`submit_enrichment_result`. See
[`docs/enrichment-protocol.md`](docs/enrichment-protocol.md) for the
wire-format spec.

```
Cortex pipelines                    Connected MCP client
       │                                    │
       │  enqueue request                   │
       ▼                                    │
  ┌────────────┐                            │
  │  Queue     │ ◄─────── poll ─────────────┤
  │            │ ─────── drain ────────────►│  (LLM call here)
  │            │ ◄────── submit ────────────┤
  └────────────┘                            │
       │                                    │
       ▼                                    │
  resume ingestion                          │
```

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
`@onenomad/cortex-memory-pgvector` provides a native hybrid-search backend
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

Two transports are supported; pick the one that matches how you're
running Cortex.

**Local (stdio, default):**

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

**Remote / containerized (HTTP):**

Set `CORTEX_MCP_TRANSPORT=http` on the server side (defaults to port
3100). Point Claude Code at the URL:

```json
{
  "mcpServers": {
    "cortex": {
      "url": "http://your-host:3100"
    }
  }
}
```

Reload Claude Code. `cortex` should appear in `/mcp` with all ten
tools currently shipped.

## Deploy with Docker

Local development doesn't need containers — `pnpm dev` + stdio MCP is
simpler. Docker is the production path: a Hetzner box (ADR-005)
serving HTTP MCP over Tailscale, optional Postgres+pgvector for the
memory fallback, optional Ollama for local LLM.

```bash
# Build + run Cortex alone (HTTP MCP on 3100, webhooks on 4040).
docker compose up -d

# With the pgvector memory fallback bundled in:
docker compose --profile pgvector up -d

# Full stack: Cortex + pgvector + Ollama:
docker compose --profile all up -d
```

The `packages/server/Dockerfile` builds a multi-stage image: install →
`tsc --build` → pruned prod deps → runtime. Config is mounted at
`/config/cortex.yaml`; state lives in the `cortex-state` volume.
Webhooks need a public URL — use Tailscale Funnel, a reverse proxy,
or ngrok depending on deployment shape. See [ADR-013](docs/DECISIONS.md).

## Architecture

```
AI Clients                         Browser
  Claude Code / Desktop / Chrome   http://localhost:3030
       │                                │
       │ MCP (stdio or HTTP)            │ fetch /api/cortex/*
       ▼                                ▼
Cortex MCP server  ◄── HTTP sidecar ──► @onenomad/cortex-dashboard
       │                                (Next.js 15, widgets)
       ├── MCP tools             17 shipped — knowledge, research,
       │                         session bridge, workspace mgmt
       │
       ├── LLM provider layer    (pluggable, per-task routing)
       │     ├── @onenomad/cortex-provider-ollama
       │     ├── @onenomad/cortex-provider-openrouter
       │     └── (future: anthropic, openai, google)
       │
       ├── Source adapters       (modular, one package each)
       │     ├── @onenomad/cortex-adapter-confluence        ✅
       │     ├── @onenomad/cortex-adapter-jira              ✅
       │     ├── @onenomad/cortex-adapter-linear            ✅
       │     ├── @onenomad/cortex-adapter-loom              ✅
       │     ├── @onenomad/cortex-adapter-notion            ✅
       │     ├── @onenomad/cortex-adapter-obsidian          ✅
       │     ├── @onenomad/cortex-adapter-bitbucket         ✅
       │     ├── @onenomad/cortex-adapter-github            ✅
       │     ├── @onenomad/cortex-adapter-slack             ✅
       │     ├── @onenomad/cortex-adapter-google-calendar   ✅  ┐
       │     ├── @onenomad/cortex-adapter-google-drive      ✅  ├─ share @onenomad/cortex-google-auth
       │     └── @onenomad/cortex-adapter-gmail             ✅  ┘
       │
       ├── Pipelines             (shape-specific, reusable)
       │     ├── @onenomad/cortex-pipeline-doc           ✅  (prose → chunked memories)
       │     ├── @onenomad/cortex-pipeline-meeting       ✅  (3-pass: structural → synthesis → brief)
       │     ├── @onenomad/cortex-pipeline-code          ✅  (per-file, language-aware chunking)
       │     └── @onenomad/cortex-pipeline-conversation  ✅  (chat threads → transcript + quotes)
       │
       ├── Memory backend        (pluggable — engram, pgvector, or remote)
       │     ├── @onenomad/engram-memory     (stdio subprocess — primary)
       │     ├── @onenomad/cortex-memory-pgvector     (Postgres + pgvector — native fallback)
       │     └── @onenomad/cortex-memory-remote       (HTTP MCP — federation, ADR-016)
       │
       ├── Workspace layer       (~/.cortex/workspaces/<slug>/)
       │     Per-user config + .env + memory state bundles.
       │     Switch via CLI, MCP, or dashboard.
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

Commands below run identically on Windows (PowerShell), macOS, and Linux:

```bash
pnpm install              # install all workspace deps
pnpm typecheck            # tsc --build across the monorepo
pnpm test                 # unit + integration tests across every package
pnpm dev                  # run `cortex start` in watch mode
pnpm smoke                # live provider smoke test
```

### Git hooks

One-time setup after clone — installs the pre-commit identifier scanner
(see [`docs/PRIVACY.md`](docs/PRIVACY.md)):

```bash
node scripts/install-hooks.mjs
```

Cross-platform; requires Node only. A bash equivalent
(`bash scripts/install-hooks.sh`) exists for macOS/Linux users who prefer it.

### Setting environment variables

Env vars are read from `.env` automatically. If you need to override at the
shell level:

- **Windows (PowerShell)**: `$env:CORTEX_MCP_TRANSPORT = "http"`
- **macOS / Linux (bash/zsh)**: `export CORTEX_MCP_TRANSPORT=http`
- **Windows (cmd)**: `set CORTEX_MCP_TRANSPORT=http`

### Chaining commands

Sequential commands (e.g., `build` then `test`):

- **Windows PowerShell 5.1**: `pnpm build; if ($?) { pnpm test }`
- **Windows PowerShell 7+** / **macOS** / **Linux**: `pnpm build && pnpm test`
- **Windows cmd**: `pnpm build && pnpm test`

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
