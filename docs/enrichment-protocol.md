# Cortex Enrichment Protocol v1

Cortex 0.2 splits the data plane (storage + retrieval) from the
compute plane (LLM-backed enrichment). Cortex Core can run with no
LLM at all. When ingestion needs structured enrichment —
categorization, action extraction, summarization, entity tagging — it
either calls an in-process LLM (when one is configured) or hands the
work off to a connected MCP client via this protocol.

This is the wire-format spec for that handoff. The reference
client is [Pyre](../../pyre), but any MCP-aware agent that implements
the two protocol tools can act as Cortex's enrichment provider.

---

## Roles

- **Cortex Core** — the data plane. Stores raw content, exposes
  retrieval. Owns the in-memory enrichment queue.
- **Enrichment provider** — an MCP client connected to Cortex's
  MCP server (Pyre, Claude Desktop, a custom agent). Drains the
  queue with `pending_enrichment_requests`, runs each request
  against its own LLM, posts the result back with
  `submit_enrichment_result`.

```
Cortex pipelines                    Connected MCP client
       │                                    │
       │  enqueue request                   │
       ▼                                    │
  ┌────────────┐                            │
  │  Queue     │ ◄─────── poll ─────────────┤
  │  (RAM)     │ ─────── drain ────────────►│
  │            │                            │ (LLM call happens here)
  │            │ ◄────── submit ────────────┤
  └────────────┘                            │
       │                                    │
       │  resolve waiting pipeline          │
       ▼                                    │
  resume ingestion                          │
```

Cortex's queue is process-local (in-memory). Pending requests at
shutdown are dropped — pipelines treat this as "no enrichment
available" and store raw content. Cross-node coordination is a v0.3
concern.

---

## MCP tools

### `pending_enrichment_requests`

Drain pending enrichment requests from the queue.

**Input:**

```json
{
  "limit": 25
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer 1-100 | 25 | max requests this poll returns |

**Output:**

```json
{
  "polledAt": "2026-05-07T14:01:23.456Z",
  "remaining": 0,
  "enabled": true,
  "requests": [
    {
      "id": "5e2c8f10-8a7b-4c3a-9d11-...",
      "enqueuedAt": "2026-05-07T14:01:20.123Z",
      "type": "categorize",
      "payload": { "content": "..." },
      "context": { "source": "loom", "trace_id": "..." }
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `polledAt` | ISO-8601 | server clock when this poll was served |
| `remaining` | integer | requests still in queue after this poll |
| `enabled` | boolean | `false` = Cortex has a local LLM, no queue |
| `requests` | array | empty when no work is pending |

When `enabled: false`, Cortex is doing enrichment in-process and the
client should stop polling. When `enabled: true` and `requests` is
empty, poll again later (recommended cadence: 1-5s).

### `submit_enrichment_result`

Post the result of one enrichment request back to Cortex.

**Input:**

```json
{
  "id": "5e2c8f10-8a7b-4c3a-9d11-...",
  "result": { "category": "engineering", "confidence": 0.91, "tags": ["..."] }
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | matches `id` from a previous `pending_enrichment_requests` call |
| `result` | object | typed per `request.type` (see below) |
| `error` | object | use instead of `result` when the provider couldn't produce a result |

**Output:**

```json
{ "accepted": true, "reason": "ok" }
```

| `reason` | When |
|---|---|
| `ok` | result delivered to the waiting pipeline |
| `unknown_id` | request expired or was never queued |
| `no_queue` | Cortex isn't running in queue mode (has a local LLM) |

---

## Request types

Each request carries a `type` and a `payload`. The `result` shape is
type-specific.

### `categorize`

Classify a piece of content into a category.

**Payload:**
```json
{ "content": "string to categorize" }
```

**Result:**
```json
{
  "category": "engineering",
  "confidence": 0.91,
  "tags": ["backend", "infra"]
}
```

### `extract_actions`

Pull action items out of free-form content (a meeting transcript, a
chat thread, a doc).

**Payload:**
```json
{
  "content": "string with action items embedded",
  "source": "loom:rec:abc"
}
```

**Result:**
```json
{
  "actions": [
    {
      "description": "Book a sync with Karim about the migration",
      "assignee": "sarah",
      "due": "2026-05-10T00:00:00+00:00",
      "source": "loom:rec:abc"
    }
  ]
}
```

`assignee` and `due` are optional. `source` echoes the input so
multi-source extractions stay traceable.

### `summarize`

Produce a TL;DR plus key bullet points.

**Payload:**
```json
{
  "content": "long-form content",
  "hint": "optional title or context for the summarizer"
}
```

**Result:**
```json
{
  "summary": "One-sentence summary.",
  "key_points": ["bullet 1", "bullet 2"]
}
```

### `tag_entities`

Extract named entities from content.

**Payload:**
```json
{ "content": "string with names, products, projects mentioned" }
```

**Result:**
```json
{
  "entities": [
    { "name": "Sarah Khan",   "type": "person",  "confidence": 0.93 },
    { "name": "Cortex",       "type": "product", "confidence": 0.88 },
    { "name": "OneNomad",     "type": "company", "confidence": 0.95 },
    { "name": "elevate",      "type": "project", "confidence": 0.71 }
  ]
}
```

`entities[].type` is one of: `person`, `project`, `company`, `product`.

---

## Errors

Either side can signal an error.

**Provider → Cortex:** post the request id with `error` instead of
`result`:

```json
{
  "id": "5e2c8f10-...",
  "error": { "code": "provider_error", "message": "openrouter rate-limited" }
}
```

Cortex treats this as "no enrichment available" and the waiting
pipeline falls back to raw storage.

**Cortex → Provider:** the standard MCP error envelope. Common
codes:

| Code | Meaning |
|---|---|
| `no_provider` | no enrichment provider connected |
| `timeout` | the queued request timed out before a result arrived (default 30s) |
| `invalid_payload` | request payload didn't match the schema for `type` |
| `provider_error` | provider returned an error envelope or threw |
| `unsupported_type` | provider doesn't handle this `type` |

---

## Tuning

The default queue is configured for a single-node Cortex with one
client. Tunables (set on `EnrichmentQueue` at server boot):

- **`timeoutMs`** (default 30_000) — per-request timeout. Pipelines
  resolve to `null` (raw storage) when this fires.
- **`maxPending`** (default 200) — backpressure cap. New requests
  beyond this resolve to `null` immediately and log
  `enrichment.queue.full`.

These ship as constants today; ADR-0XX (TBD) will route them
through `cortex.yaml > enrichment` once the production deployment
shape stabilizes.

---

## Pipeline behavior without a provider

When Cortex has neither a local LLM nor a connected enrichment
provider:

| Pipeline | Without enrichment |
|---|---|
| `pipeline-doc` | full behavior — chunking is rule-based, no LLM needed |
| `pipeline-code` | full behavior — chunking is language-aware, no LLM needed |
| `pipeline-conversation` | thread + per-day + quote memories emitted; signal extractor (due/owner) skipped |
| `pipeline-meeting` | transcript chunks emitted; brief / decisions / action items skipped |

In every case retrieval still works against the raw memories that
were ingested. Connect an enrichment provider later and re-run the
adapter to backfill the structured layer.

---

## Versioning

This document covers Protocol v1 — the shape that ships with
Cortex 0.2. Breaking changes will introduce a v2 namespace
(`pending_enrichment_requests_v2`, etc.) with v1 deprecated for at
least one minor release before removal.
