# How Cortex works

Cortex is a single MCP server with an in-process vector store, a set of
source adapters that pull content from your tools, and an enrichment
pipeline that runs through either a local LLM provider or your connected
MCP client.

```
 +-------------------------------------------------------+
 |  AI client (Claude Code, Claude.ai, Pyre, ...)        |
 +--------------------------+----------------------------+
                            | MCP (stdio or HTTP)
 +--------------------------v----------------------------+
 |  Cortex                                               |
 |  - Domain MCP tools (projects, search, briefs, ...)   |
 |  - Source adapters (Confluence, GitHub, Slack, ...)   |
 |  - Enrichment pipelines (structural / synthesis /     |
 |    brief / classify)                                  |
 |  - Memory: in-process pgvector + hybrid search        |
 +-------------------------------------------------------+
```

There are no companion services. Cortex 0.3 onward is standalone — no
Engram or Persona subprocess to manage. Memory lives in pgvector
(embedded PGlite by default, or an external Postgres you point it at).

## Components

### MCP server

Cortex exposes its tools through the Model Context Protocol over stdio
or HTTP. Any MCP-aware client connects the same way. The HTTP transport
is the right choice when more than one client needs to share the same
Cortex instance (a developer laptop + the team's CI pipeline, for
example).

### Memory backend

A single in-process vector store backed by pgvector. Two modes:

- **Embedded** (default): PGlite, a WASM build of Postgres that runs in
  the Cortex process. Zero external dependencies. Storage lives under
  the workspace data dir on local disk.
- **External**: a connection string to a Postgres server you operate.
  Use this for shared-team installs or when storage needs to live on
  network-attached infrastructure.

Both modes use the same DDL and the same query path. Migration between
them is a config change, not a code change.

Embeddings come from a bundled local model (MiniLM-L6-v2, 384-dim, runs
on CPU). Wiring an LLM provider's embed task replaces the local model
with a provider-routed one.

### Source adapters

One adapter per source, all conforming to the same contract: `fetch`,
`transform`, `classify`, `ingest`. The ingest path is idempotent —
re-running an adapter on the same content updates existing entries
rather than duplicating them.

Adapters available today: Confluence, Jira, Bitbucket, GitHub, Linear,
Notion, Loom, Slack, Obsidian, Google Calendar, Microsoft Graph
(Outlook). Each ships as its own package and is enabled per-workspace
in `cortex.yaml`.

### Enrichment pipeline

When an LLM provider is wired, ingested content runs through a
three-pass pipeline:

1. **Structural** — extract a typed schema (action items, decisions,
   key entities, references) from raw content.
2. **Synthesis** — combine structured outputs across the document into
   a coherent picture.
3. **Brief** — render a short human-readable summary.

Each stage is independently configurable in `cortex.yaml > llm.tasks`.
The shipped default uses Haiku 4.5 for high-frequency stages and Sonnet
4.6 for synthesis.

If no LLM provider is configured, Cortex falls back to the **enrichment
protocol**: the connected MCP client (Pyre, Claude Desktop, a custom
agent) is invited to provide enrichments by calling
`submit_enrichment_result` against pending requests pulled from
`pending_enrichment_requests`. See [enrichment-protocol](./enrichment-protocol.md).

### Metadata contract

Every memory carries the same shape:

```json
{
  "domain": "work",
  "source": "confluence | github | slack | ...",
  "source_id": "stable-id-from-source",
  "source_url": "https://...",
  "project": "project-slug | [project-a, project-b]",
  "type": "meeting | decision | action_item | doc | code | note | brief | digest",
  "people": ["person-slug", "..."],
  "date": "ISO 8601 timestamp",
  "confidence": "0.0–1.0"
}
```

Cortex's search tools filter on these fields. The contract is
load-bearing — every adapter must conform.

## What runs in a Cortex install

A single Node process per workspace, plus the dashboard (Next.js) when
enabled. Optional companion containers: an external Postgres if you opt
out of the embedded mode, or a local Ollama if you want LLM inference
to stay on your hardware. Nothing else.
