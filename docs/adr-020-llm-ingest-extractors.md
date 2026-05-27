# ADR-020: LLM ingest-time extractors (summary + keywords) (2026-05-27)

**Status**: Accepted

**Context**

Cortex is an AI-friendly, multi-tenant knowledgebase; its core job is retrieval — hybrid RRF over a pgvector `embedding` and a `tsv` full-text column, **both keyed off the `content` column today** (`packages/memory-pgvector/src/schema.ts`: `tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`; `backend.ingest` embeds `input.content`).

Ingest-time LLM enrichment already exists — `server/src/enrichment/extract-structured-items.ts`, invoked from `mcp/tools/ingest-content.ts` (~line 373) when an LLM provider is configured. We want additional ingest-time annotations that **measurably improve retrieval** and give agents/UI a usable abstract, **without** query-time LLM calls (cortex stays zero-LLM at query time).

No production corpus exists yet, so the embedding/full-text seam can be changed for free now. Changing it after a corpus exists means re-embedding every tenant — so we set it correctly now.

**Decision**

1. **Extractor framework.** A uniform `Extractor` interface in `server/src/enrichment/` — roughly `{ name, enabled(config), run(item, ctx): Promise<Partial<MemoryMetadata>> }` — run at ingest where `extractStructuredItems` runs, gated on (a) LLM-provider presence and (b) per-extractor opt-in config in `cortex.yaml` (**off by default**). Prompts live as `.md` files (ADR-007). Shaped so an entity/relation extractor (future KG) and a questions-answered extractor can be added without reshaping the interface, and so it can extend to adapter ingest paths later.
2. **Two v1 extractors.** `summary` → `metadata.summary` (concise gist); `keywords` → `metadata.keywords: string[]` (terms / acronyms / jargon).
3. **Contract.** Add `summary?: string` and `keywords?: string[]` to the Zod schema (`packages/core/src/metadata.ts`) and `schemas/memory-metadata.json`. The metadata-conformance test (`packages/core/tests/metadata-conformance.test.ts`) enforces the two schemas stay in sync.
4. **Retrieval wiring — the point of the feature.**
   - **Full-text:** change the `tsv` generated column to include the enrichment, e.g. `to_tsvector('english', content || ' ' || coalesce(metadata->>'summary','') || ' ' || coalesce(<keywords joined from metadata>,''))`. Schema change — free now (no data). `coalesce(...,'')` means rows without enrichment produce the **identical** tsvector as today.
   - **Embedding:** embed a composed text (content + summary + keywords), not raw content. Add an optional `embedText` to `MemoryIngestInput` (defaults to `content`) so stored `content` stays pure while the vector reflects enrichment; the pgvector client (`packages/server/src/clients/pgvector.ts`) composes `embedText` from content + extractor output.
5. **Eval.** A retrieval eval — a small fixture corpus + query→expected-chunk cases — measuring recall **with vs without** enrichment. Adding more extractors (questions-answered/HyDE, entities) is gated on **measured lift**, not assumed.
6. **Cost.** Opt-in per extractor; runs only with an LLM provider configured. Per-tenant ingest cost is real (multi-tenant cloud); full cost governance is later — opt-in + off-by-default covers v1.

**Consequences**

- Better recall (gist + jargon reach both the vector and full-text channels) and agent/UI-usable summaries.
- The embedding and `tsv` now depend on enrichment; changing the composition later requires a re-embed — which is exactly why we set it while the corpus is empty.
- Ingest cost only when enabled; **default behavior is byte-identical to today** (no extractor → `embedText` = content, `coalesce` → same tsvector). Query path stays zero-LLM.
- The metadata contract grows by two optional fields; the conformance test guards drift.
- The framework is extensible to entities (KG) and questions-answered as measured follow-ons.

_Logged in DECISIONS.md as ADR-020._
