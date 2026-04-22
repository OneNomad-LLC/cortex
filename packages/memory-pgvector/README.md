# @cortex/memory-pgvector

Native hybrid-search memory backend for Cortex. Postgres + `pgvector` +
`tsvector`, fused with **reciprocal rank fusion**. Implements the same
`ingest` / `search` / `healthCheck` surface as the Engram MCP client so the
Cortex server can treat either one as primary and the other as fallback.

## Why this exists

Cortex runs against Engram by default. When the Engram subprocess is down, or
on deployments that prefer a SQL store over a side-car, Cortex still needs to
answer search queries. This package is that fallback — a single table with a
vector index and a tsvector index, fused at query time.

## What it does

- **Schema bootstrap**: `CREATE EXTENSION vector`, one `cortex_memories`
  table, HNSW index on `embedding`, GIN index on `tsv`, JSONB expression
  indexes on `project`, `type`, `source`, `domain`, and `date`.
- **Idempotent ingest**: upsert on `source_id` (matching Engram's
  behavior); rows without a `source_id` just insert.
- **Hybrid search**: vector top-K (`embedding <=> query_vec`) + text top-K
  (`ts_rank_cd(tsv, websearch_to_tsquery(query))`) fused via RRF with
  `k = 60` (Cormack/Clarke/Buettcher).
- **Filters**: `project`, `type`, `source`, `domain`, `sinceIso` apply
  inside each CTE so out-of-scope rows never reach the fusion stage.

## Usage

```ts
import { createPgPool, createPgVectorBackend } from "@cortex/memory-pgvector";

const pool = createPgPool({ connectionString: process.env.POSTGRES_URL });
const backend = createPgVectorBackend({
  pool,
  embed: async (text) => {
    // Any function that maps text -> fixed-length number[]. Wire to
    // ollama's /api/embeddings, OpenAI-compatible /embeddings, etc.
  },
  config: { embeddingDim: 768 },
  logger,
});

await backend.bootstrap();
await backend.ingest({
  content: "Decision: use Redis for rate limiting.",
  metadata: {
    source_id: "confluence:42",
    domain: "work",
    project: "alpha",
    type: "decision",
    source: "confluence",
    date: new Date().toISOString(),
  },
});

const hits = await backend.search({
  query: "rate limiting",
  project: "alpha",
  limit: 10,
});
```

## Embedding dimension

`pgvector` fixes the dimension at column-definition time. Pick a dimension
once and stick with it — changing later means an `ALTER TABLE` plus a
re-embed of every row. Reasonable defaults:

| Model                              | Dim |
|------------------------------------|-----|
| `nomic-embed-text` (Ollama)        | 768 |
| `all-MiniLM-L6-v2`                 | 384 |
| `text-embedding-3-small` (OpenAI)  | 1536 |

## Running tests

```bash
pnpm --filter @cortex/memory-pgvector test
```

Tests run with an in-memory stub, so Postgres is **not** required. For a real
smoke test against a live database, point `POSTGRES_URL` at a Postgres
instance with `pgvector` installed and run the integration suite (not yet
wired — TODO).
