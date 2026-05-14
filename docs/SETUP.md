# Setup

First-run setup of a Cortex install. Three phases: get the server
running, point an MCP client at it, configure providers and adapters.

For production deployment topology (always-on host, reverse proxy,
backups), see [DEPLOY](./DEPLOY.md). For host sizing recommendations,
see [HOSTING](./HOSTING.md).

## Prerequisites

- Node 20+ (Linux, macOS, or Windows)
- pnpm 9+
- Optional: Docker if you want to run the included compose stack
- An OpenRouter, Anthropic, OpenAI, or Google API key, **or** a local
  Ollama install with at least one model pulled, **or** neither — Cortex
  works without an LLM provider by delegating enrichment to the
  connected MCP client (see [enrichment-protocol](./enrichment-protocol.md))

## 1. Install and build

```bash
git clone <your-cortex-checkout>
cd cortex
pnpm install
pnpm -r build
```

A full build compiles the server, dashboard, adapters, providers, and
pipelines into `dist/` directories ready to run.

## 2. Create a workspace

Workspaces bundle config + secrets + memory state. One Cortex install
can serve multiple workspaces; the active one is selected via the
dashboard's workspace switcher or by running `cortex workspace switch
<slug>`.

```bash
node packages/server/dist/index.js workspace add default
```

This creates `~/.cortex/workspaces/default/` with a minimal
`cortex.yaml` and an empty `.env`. The workspace becomes active
automatically.

## 3. Start Cortex

For local development, run Cortex as an HTTP daemon. This also starts
the dashboard at <http://localhost:3030> automatically:

```bash
CORTEX_MCP_TRANSPORT=http \
CORTEX_MCP_HOST=127.0.0.1 \
CORTEX_MCP_PORT=3100 \
node packages/server/dist/index.js start
```

You should see:

- `memory.ready selected=pgvector mode=embedded` — the in-process
  Postgres + vector store is up
- `mcp.connected transport=http port=3100` — the MCP endpoint is
  listening
- `dashboard.started port=3030` — the admin UI is ready

For production daemonization, see [DEPLOY](./DEPLOY.md).

## 4. Configure providers and adapters

Open the dashboard at <http://localhost:3030>. The operator overview
will tell you nothing is configured yet. From there:

1. **Providers** — wire your LLM provider (OpenRouter is recommended
   for cloud installs; one key covers Anthropic, OpenAI, Google,
   Mistral, and more). Skip this if you want to run Cortex as a
   pure data plane with enrichment delegated to your MCP client.
2. **Adapters** — enable the sources you want Cortex to ingest from
   (Confluence, GitHub, Slack, Linear, Notion, Obsidian, ...). Each
   adapter has its own wizard for credentials and scope.

## 5. Connect an MCP client

Add Cortex to your MCP client's server config. For Claude Code:

```bash
claude mcp add --scope user --transport http cortex http://127.0.0.1:3100/mcp
```

For other clients, the connection string is the same:
`http://<host>:3100/mcp`.

`claude mcp list` should show `cortex (HTTP) ✓ Connected`. From the
client, `/tools` lists Cortex's domain tools alongside whatever else
you have wired.

## Configuration files

Per-workspace config lives at `~/.cortex/workspaces/<slug>/`:

- `config/cortex.yaml` — providers, tasks, adapters, memory backend
- `.env` — secrets (API keys, OAuth tokens)

Both are managed by the dashboard wizards in normal use; hand-editing
is supported but optional.

## Environment variables

Set these in the shell that starts the daemon, or in
`~/.cortex/workspaces/<slug>/.env`:

| Variable | Purpose |
|---|---|
| `CORTEX_MCP_TRANSPORT` | `stdio` (default, single-client) or `http` (multi-client) |
| `CORTEX_MCP_HOST` | Bind address when `transport=http`. Default `127.0.0.1` |
| `CORTEX_MCP_PORT` | Port when `transport=http`. Default `3100` |
| `CORTEX_API_PORT` | Dashboard API sidecar port. Default `4141` |
| `CORTEX_DASHBOARD_PORT` | Dashboard UI port. Default `3030` |
| `CORTEX_WORKSPACE` | Pin a specific workspace at boot, overriding the active pointer |
| `OPENROUTER_API_KEY` | OpenRouter BYOK key (recommended provider) |
| `OLLAMA_HOST` | Ollama server URL when using local inference |

Provider-specific keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, adapter tokens) live in `.env` and are loaded
automatically.

## Verifying the install

```bash
node packages/server/dist/index.js doctor --connect
```

`doctor` runs pre-flight checks (config validity, secrets present,
taxonomy parseable, providers reachable, memory backend healthy) and
prints a diff of what's wrong if anything fails. `--connect` adds live
probes against Postgres and configured providers.

## Next steps

- [HOSTING](./HOSTING.md) — recommended host topologies for production
- [DEPLOY](./DEPLOY.md) — putting Cortex on an always-on box
- [enrichment-protocol](./enrichment-protocol.md) — running Cortex
  without a local LLM provider
- [PRIVACY](./PRIVACY.md) — PII hygiene and the identifier scanner
