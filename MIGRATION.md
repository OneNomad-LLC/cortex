# Migrating to Cortex 0.2

Cortex 0.2 ships two breaking changes. No back-compat: the old API
is removed, not aliased. There are no paying users yet — anyone
touching the repo before public release is the audience for this
document.

## 1. Time-relative MCP tools removed

Five tools have been replaced or deleted to make Cortex's surface
universal-knowledge-shaped instead of personal-assistant-shaped.

| Removed (0.1) | Replacement (0.2) | Notes |
|---|---|---|
| `todays_digest` | `digest({ since?, until?, project?, assignee? })` | defaults to a 24h window centered on now |
| `catch_me_up` | `summarize_recent({ project?, since?, types?, limit? })` | defaults to last 7d |
| `catch_me_up_on_meeting` | `summarize_meeting({ id })` | entity-keyed; `id` accepts source_id, url, or query |
| `my_action_items` | `pending_action_items({ assignee?, project?, since?, includeDone?, limit? })` | renamed `owner` → `assignee` |
| `upcoming_briefs` | (deleted) | dashboard widget preserved at `/api/widgets/upcoming-briefs` |

All `since` / `until` parameters are ISO-8601 timestamps (e.g.
`2026-04-01T00:00:00Z`). The `assignee` parameter on
`pending_action_items` accepts a slug, name, email, or alias — same
matching as the previous `owner` parameter.

The `upcoming_briefs` dashboard widget is unchanged from a UX
perspective. Clients that called the MCP tool directly need to
either replace those calls with `digest({ until: ... })` or hit the
dashboard widget endpoint directly.

## 2. LLM is no longer required

Cortex Core runs with zero LLM. Storage, retrieval, and adapters all
work without one.

**Provider packages** (`@onenomad/przm-cortex-provider-ollama`,
`@onenomad/przm-cortex-provider-openrouter`, `@onenomad/przm-cortex-llm-sdk`)
moved from `dependencies` to `optionalDependencies` in
`@onenomad/przm-cortex` (the server package). `pnpm install` will still
resolve them inside the workspace, but a bare `npm i -g
@onenomad/przm-cortex` (when published) will skip them by default.

**Pipelines that needed an LLM** (meeting, research, conversation
signal extraction) now check for it and fall back to one of two
behaviors:

1. **MCP enrichment callback** — when an MCP client connects and
   answers via the new Cortex Enrichment Protocol, pipelines route
   enrichment requests through the queue. See
   [`docs/enrichment-protocol.md`](docs/enrichment-protocol.md).
2. **Raw storage** — when neither an LLM nor an enrichment provider
   is available, pipelines store the raw content and skip the
   structured outputs (no brief, no decisions, no action items).
   Search still works against the raw memories.

Startup logs make the mode explicit:

```
INFO  cortex-server llm.router.ready providerCount=0 hasLocalLlm=false
WARN  cortex-server llm.no_providers
       hint=Running without enrichment. Connect an MCP client (Pyre,
       Claude Desktop) to enable structured enrichment via the Cortex
       Enrichment Protocol — see docs/enrichment-protocol.md.
INFO  cortex-server enrichment.queue.ready mode=mcp-client-driven
```

## 3. New MCP tools

Two new tools surface the Cortex Enrichment Protocol to connected
clients:

- **`pending_enrichment_requests({ limit? })`** — drain pending
  enrichment requests so the client can process them with its own
  LLM.
- **`submit_enrichment_result({ id, result | error })`** — post
  results back so the waiting Cortex pipeline can resume.

Both tools no-op (return `{ enabled: false }` / `{ reason: "no_queue" }`)
when Cortex is running with a local LLM.

## 4. Internal API changes

These touch developers extending Cortex; not relevant to MCP clients.

### `AdapterContext.llm` is now optional

```ts
export interface AdapterContext {
  // ...
  llm?: LLMAccess; // was: required
}
```

Adapters that need LLM-backed classification must check for presence:

```ts
if (ctx.llm) {
  const result = await ctx.llm.complete({...});
}
```

The `@onenomad/przm-cortex-adapter-sdk` `classifier-llm.ts` already
handles this for the most common case (LLM classification fallback).

### `PipelineContext.llm` is now optional, plus new `enrichment` field

```ts
export interface PipelineContext {
  // ...
  llm?: { complete(...) }; // was: required
  enrichment?: EnrichmentClient; // new — Cortex Enrichment Protocol callback
}
```

Pipelines that need enrichment now pattern-match:

```ts
if (ctx.llm) {
  // do the LLM call directly
} else if (ctx.enrichment) {
  // queue an enrichment request, await result
} else {
  // store raw, skip enrichment
}
```

### `LLMRouter` build returns optional router

`buildLLMRouter` no longer throws when no providers are configured.
It returns `{ router?: LLMRouter, providers, hasLocalLlm: boolean }`.
Callsites that used to assume a router must check the `hasLocalLlm`
flag and degrade gracefully.

## Quick smoke test

After upgrading, verify the new mode:

```bash
# 1. Disable every LLM provider in cortex.yaml
#    (or delete the llm.providers block entirely)

# 2. Boot Cortex
cortex start

# 3. Look for these log lines
#    - llm.router.ready hasLocalLlm=false
#    - llm.no_providers
#    - enrichment.queue.ready mode=mcp-client-driven

# 4. From a connected MCP client, invoke pending_enrichment_requests:
#    { "enabled": true, "remaining": 0, "requests": [] }

# 5. Drop a transcript through the meeting pipeline (cortex import meeting),
#    poll pending_enrichment_requests — you should see two queued requests
#    (one summarize, one extract_actions) until you submit_enrichment_result
#    or 30s elapses.
```

See [`docs/enrichment-protocol.md`](docs/enrichment-protocol.md) for
the full wire-format spec.
