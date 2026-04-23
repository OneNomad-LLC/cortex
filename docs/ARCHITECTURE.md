# Architecture

## Layering Philosophy

Cortex sits on top of two existing MCP servers and below the user's AI client.
The boundaries are intentional and load-bearing.

```
 +-------------------------------------------------------+
 |  AI Client (Claude Code, Claude.ai, etc.)             |
 +--------------------------+----------------------------+
                            | MCP
 +--------------------------v----------------------------+
 |  Cortex MCP Server                                    |
 |  - Work-specific tools                                |
 |  - Adapter registry (loads source adapters)          |
 |  - Pipelines (extraction, classification, briefs)     |
 |  - Project taxonomy                                   |
 +-----------+--------------+-------------+--------------+
             | MCP          | MCP         | adapters
             |              |             |
 +-----------v---+  +-------v-----+  +----v-----------+
 |  Engram MCP   |  | Persona MCP |  | Source Adapters|
 |  - Storage    |  | - Style     |  | (modular)      |
 |  - Retrieval  |  | - Cognition |  | - Loom         |
 |  - KG         |  |             |  | - Confluence   |
 +---------------+  +-------------+  | - Obsidian     |
                                     | - Bitbucket    |
                                     | - Calendar     |
                                     | - ...future    |
                                     +----------------+
```

### Why these boundaries

**Cortex <-> Engram/Persona over MCP, not code**: Lets Engram and Persona evolve
as clean public projects. Protects Cortex from upstream refactors. Keeps
licensing boundaries clean for eventual commercialization. Makes it possible
to swap memory backends later if needed.

**Cortex owns domain knowledge**: Projects, meetings, action items,
source-specific concepts. Engram doesn't know what Loom is. Persona doesn't
know what a sprint is. That's Cortex's job.

**AI client talks only to Cortex**: Users don't need to know about the two
backing services. One MCP endpoint, unified experience.

**Adapters are first-class and modular**: Every data source implements the
same contract. New sources are new packages, not new code scattered through
Cortex. See "Adapter Framework" below.

## Adapter Framework

Sources (Loom, Confluence, Bitbucket, Obsidian, etc.) are modular adapters
that implement a common interface. This is a load-bearing architectural
decision: done right, adding a new source is a contained project; done wrong,
it's a structural refactor every time.

### The Contract

Every adapter implements `SourceAdapter` from `@onenomad/cortex-core`:

```typescript
export interface SourceAdapter {
  // Identity
  readonly id: string;              // "loom", "confluence", etc.
  readonly name: string;            // human-readable
  readonly version: string;         // for compatibility checks

  // Configuration declaration
  configSchema: z.ZodSchema;        // adapter-specific config shape
  requiredSecrets: string[];        // env var names this adapter needs

  // Lifecycle
  init(ctx: AdapterContext): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  shutdown(): Promise<void>;

  // Core operations
  fetch(since?: Date): AsyncIterable<RawSourceItem>;
  transform(raw: RawSourceItem): Promise<NormalizedItem>;
  classify(item: NormalizedItem, ctx: ClassificationContext): Promise<ClassifiedItem>;

  // Capability declaration
  capabilities: AdapterCapabilities;
}

export interface AdapterCapabilities {
  supportsIncrementalSync: boolean;
  supportsWebhooks: boolean;
  supportsAttachments: boolean;
  supportsComments: boolean;
  supportsRealTime: boolean;
}
```

The `AdapterContext` injected at init time provides everything the adapter
needs: Engram client, logger, LLM clients (Ollama + OpenRouter), project
taxonomy, config loader. Adapters never reach for globals.

### The Normalized Shape

Every adapter outputs a common `NormalizedItem`. This is what enables
cross-source queries and a single metadata contract in Engram:

```typescript
export interface NormalizedItem {
  sourceId: string;               // stable id from the source (for dedup)
  sourceType: SourceType;         // "loom" | "confluence" | ...
  sourceUrl: string;              // canonical link back to original
  title: string;
  content: string;                // markdown/plain text
  contentType: ContentType;       // "meeting" | "doc" | "code" | "note" | ...
  createdAt: Date;
  updatedAt: Date;
  authors: string[];              // person slugs (resolved via people.yaml)
  parentId?: string;              // for hierarchical content
  attachments?: Attachment[];
  rawMetadata: Record<string, unknown>;  // source-specific extras preserved
}

export interface ClassifiedItem extends NormalizedItem {
  projects: string[];             // project slugs
  confidence: number;             // 0-1
  classificationMethod: "attendee-match" | "content-llm" | "rule" | "manual";
}
```

Classification is a separate step that enriches a NormalizedItem with project
tags. Most adapters use the default LLM-based classifier from the SDK; some
(like Confluence, where space maps to project) can override with rule-based.

### Package Structure

Monorepo with npm workspaces. Each adapter is its own package with its own
dependencies, tests, and README.

```
cortex/
  package.json                    # workspace root
  pnpm-workspace.yaml             # or npm workspaces config
  packages/
    core/                         # @onenomad/cortex-core
      src/
        adapter.ts                # SourceAdapter interface
        types.ts                  # NormalizedItem, ClassifiedItem, etc.
        context.ts                # AdapterContext
        capabilities.ts
      package.json

    adapter-sdk/                  # @onenomad/cortex-adapter-sdk
      src/
        base-adapter.ts           # optional base class
        retry.ts
        rate-limit.ts
        idempotency.ts            # source_id-based dedup helpers
        classifier-llm.ts         # default LLM classifier
        classifier-rule.ts        # rule-based classifier
      package.json

    pipeline-core/                # @onenomad/cortex-pipeline-core
      src/
        pipeline.ts               # generic pipeline framework
      package.json

    pipeline-meeting/             # @onenomad/cortex-pipeline-meeting
      src/...                     # 3-pass extraction for transcripts
      package.json

    pipeline-doc/                 # @onenomad/cortex-pipeline-doc
      src/...                     # chunking + enrichment for docs
      package.json

    adapter-loom/                 # @onenomad/cortex-adapter-loom
      src/
        index.ts                  # exports createAdapter()
        api-client.ts
        transformer.ts
        config.ts
      package.json                # depends on @onenomad/cortex-core, @onenomad/cortex-adapter-sdk
      README.md

    adapter-confluence/           # @onenomad/cortex-adapter-confluence
      src/...
      package.json

    adapter-obsidian/             # @onenomad/cortex-adapter-obsidian
      src/...
      package.json

    server/                       # @onenomad/cortex-server (the MCP server itself)
      src/
        mcp/
          server.ts
          tools/
        clients/
          engram.ts
          persona.ts
        llm/
          ollama.ts
          openrouter.ts
        registry.ts               # adapter discovery and lifecycle
        scheduler.ts              # runs adapters on their schedules
      package.json

  config/
    cortex.yaml                   # which adapters are enabled
    projects.yaml
    people.yaml

  schemas/
    memory-metadata.json
```

### The Registry

Cortex server loads enabled adapters at startup based on `config/cortex.yaml`:

```yaml
adapters:
  loom:
    enabled: true
    package: "@onenomad/cortex-adapter-loom"
    schedule: "*/15 * * * *"      # every 15 min
    config:
      poll_new_only: true

  confluence:
    enabled: true
    package: "@onenomad/cortex-adapter-confluence"
    schedule: "0 */6 * * *"       # every 6 hours
    config:
      spaces: ["ALPHA", "BETA"]

  obsidian:
    enabled: false                # will enable when you start taking notes
    package: "@onenomad/cortex-adapter-obsidian"
```

Operations on adapters:
- **Toggle off**: set `enabled: false`, restart
- **Remove entirely**: delete the package, remove config entry, restart
- **Add new**: install the package, add config block, restart
- **Reconfigure**: edit `config` block, restart (hot reload is Phase 11+)

The registry:

1. Reads `cortex.yaml`
2. For each enabled adapter, imports the package statically (resolved by
   workspace; no dynamic require)
3. Calls `createAdapter()` to get the `SourceAdapter` instance
4. Validates the adapter's config against its Zod schema
5. Confirms required secrets are present in env
6. Calls `init(ctx)` with the injected context
7. Registers on the scheduler

Adapter registration is a compile-time + config-time contract. TypeScript
catches interface mismatches. Runtime catches config or credential issues
before any pipeline work happens.

### Writing a New Adapter

The happy path for adding, say, Slack:

1. `mkdir packages/adapter-slack && cd packages/adapter-slack`
2. `npm init`, add dependencies on `@onenomad/cortex-core` and `@onenomad/cortex-adapter-sdk`
3. Implement `SourceAdapter` in `src/index.ts`. Extend `BaseAdapter` from the
   SDK to inherit retry, rate-limit, and idempotency handling.
4. Write transformer: Slack message -> NormalizedItem. Decide contentType
   ("conversation" probably; add to the enum if needed).
5. Decide whether to use the default LLM classifier or write a rule-based one
   (Slack channels often map to projects — rule-based makes sense).
6. Declare capabilities (webhooks: true, realtime: possible, etc.).
7. Add tests against fixture data.
8. Add a block to `config/cortex.yaml` with `enabled: true`.
9. Restart Cortex.

Roughly a day of work for a well-scoped source. Not weeks.

### Pipelines Are Also Modular

The meeting extraction pipeline is specific to transcript-shaped content. The
doc pipeline handles prose. Code needs different treatment entirely. Rather
than bake these into the adapters, they're separate `@onenomad/cortex-pipeline-*`
packages.

Each adapter declares which pipeline(s) its content flows through:

```typescript
class LoomAdapter extends BaseAdapter {
  pipelines = ["@onenomad/cortex-pipeline-meeting"];
}

class ConfluenceAdapter extends BaseAdapter {
  pipelines = ["@onenomad/cortex-pipeline-doc"];
}

class BitbucketAdapter extends BaseAdapter {
  pipelines = ["@onenomad/cortex-pipeline-code"];
}
```

This matters because new adapter types should be able to reuse existing
pipelines without rewriting extraction logic. A Notion adapter would use
`@onenomad/cortex-pipeline-doc`. A Google Meet adapter would use
`@onenomad/cortex-pipeline-meeting`.

When no existing pipeline fits, add a new one as a package. The framework
doesn't care.

## Component Responsibilities

### Cortex MCP Server

Exposes the tools that users invoke through their AI client. Examples:
`list_projects`, `get_project_context`, `my_action_items`,
`catch_me_up_on_meeting`, `upcoming_briefs`, `weekly_rollup`, `search`.

Each tool is a thin orchestrator: validate inputs, call Engram/Persona, format
response. No business logic of note.

Also hosts the adapter registry, scheduler, and pipeline runtime.

### Adapters

Covered in detail above. One per external source. Responsibilities in order:

1. **Fetch**: Pull new/changed content from the source.
2. **Transform**: Normalize to `NormalizedItem`.
3. **Classify**: Tag with project(s) and confidence.
4. **Hand off to pipeline(s)**: For extraction and ingestion into Engram.

### Pipelines

Multi-stage processing between adapters and Engram ingestion. Generic
framework in `@onenomad/cortex-pipeline-core`; specific implementations as separate
packages. Examples:

- **pipeline-meeting**: structural -> synthesis -> brief for transcripts.
- **pipeline-doc**: chunk by heading, extract decisions, link relationships.
- **pipeline-code**: tree-sitter chunking, dual-representation indexing.

Pipelines take classified items and produce one or more memories to ingest.
Pure functions where possible. Testable in isolation with fixtures.

### Clients

`packages/server/src/clients/engram.ts` and `persona.ts` are typed wrappers
over each upstream MCP. They expose TypeScript functions whose signatures
match the underlying MCP tools. No business logic.

### Domain Layer

`packages/core/src/types.ts` and related files hold pure TypeScript types and
logic with no I/O. These types flow through every adapter and pipeline.
Changes here ripple — keep them intentional.

## Data Flow: Example

A Loom meeting finishes. Here's what happens:

```
1. Scheduler fires Loom adapter
   -> adapter.fetch(since=lastRun) yields new transcripts
2. For each raw item:
   a. adapter.transform(raw) -> NormalizedItem
   b. adapter.classify(item, ctx) -> ClassifiedItem (project + confidence)
3. Registry routes ClassifiedItem to declared pipeline(s):
   a. pipeline-meeting runs 3-pass extraction:
      - Pass 1 (local Qwen 14B): structural extraction
      - Pass 2 (OpenRouter Haiku): synthesis with retrieved context
      - Pass 3 (local Qwen 14B): brief generation
4. Pipeline produces multiple memories:
   - one memory per decision
   - one memory per action item
   - one for the brief
   - chunks for the raw transcript
   - all share the same source_id for idempotency
5. Ingestion layer writes to Engram via MCP with full metadata contract
6. Engram auto-populates knowledge graph (attendees, decisions, links)
```

User next morning via Claude Code / claude.ai:

```
1. "what happened in Project A's planning meeting yesterday?"
2. Cortex MCP tool `catch_me_up_on_meeting` invoked
3. Cortex queries Engram filtered by project=project-a, source=loom,
   date=yesterday, type=brief
4. Cortex queries Persona for current cognitive_load
5. If high load: return terse brief. Else: return full brief + related.
6. Response formatted with links back to source
```

## Memory Metadata Contract

Authoritative schema: `schemas/memory-metadata.json`.

Every ingestion must populate:

- `domain`: always `"work"` for Cortex-ingested memories
- `source`: source id (matches adapter id)
- `source_id`: stable identifier from the source (for dedup)
- `source_url`: canonical URL back to original content
- `project`: slug or array of slugs from `config/projects.yaml`
- `type`: one of the defined content types
- `people`: array of person slugs from `config/people.yaml`
- `date`: ISO 8601 timestamp of the content (not ingestion time)
- `confidence`: 0.0-1.0 for inferred fields like project classification

Optional but recommended:

- `title`: human-readable reference for UI/logs
- `parent_id`: for hierarchical content
- `tags`: freeform strings for secondary categorization

This contract is the bridge between the adapter's NormalizedItem and Engram's
storage. It's what makes cross-source queries work.

## Reference Layer in Engram

Engram's default cognitive layers (episodic, semantic, procedural) all decay.
Work reference material (Confluence docs, code, architectural decisions)
should not decay like personal memories.

Proposed upstream: a new `reference` cognitive layer with near-zero decay.
See ADR-002.

## Multi-Machine Considerations

Cortex, Engram, and Persona run as services. The author uses multiple machines
(Windows desktop, Mac, VPS). Single source of truth matters.

Chosen deployment: all three services run on a single host (Hetzner CCX13).
AI clients on any machine connect to the remote MCPs via Tailscale. See
HOSTING.md.

Ingestion can run where convenient:
- Obsidian adapter runs on the machine with the vault (Mac, eventually)
- Heavy extraction (local LLM) runs wherever Ollama is available (Windows
  primary, Mac fallback)
- API adapters (Loom, Atlassian, Calendar) can run on the server directly

## Failure Modes and Recovery

**Source API outage**: adapter retries with exponential backoff (SDK default),
skips run if persistent. Backlog gets picked up on next successful run.

**LLM unavailable**: pipelines call an LLM abstraction that tries Ollama first,
falls back to OpenRouter if primary is unreachable. Never silently drops work.

**Engram unavailable**: Cortex tools return an error to the AI client.
Ingestion queues to disk until Engram is reachable. No silent data loss.

**Adapter misconfigured**: registry rejects it at startup with clear error.
Other adapters continue normally.

**Corruption of LanceDB**: Engram is backed up nightly. Restore procedure in
HOSTING.md.

**Classification wrong**: memories carry confidence scores. Review queue
exposed via `list_unclassified` tool. Weekly triage cadence.
