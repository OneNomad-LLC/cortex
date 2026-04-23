# @onenomad/cortex-pipeline-doc

Pipeline for prose content — docs, wiki pages, tickets, notes. Chunks by
heading hierarchy and emits one memory per chunk.

Used by `@onenomad/cortex-adapter-confluence`, `@onenomad/cortex-adapter-notion`,
`@onenomad/cortex-adapter-jira`, `@onenomad/cortex-adapter-google-drive`,
`@onenomad/cortex-adapter-obsidian`.

Stages:

1. **Chunk** — split markdown on heading boundaries, preserve the heading
   path as `parent_id`-ish breadcrumbs in metadata.
2. **Ingest-shape** — produce a `PipelineMemory` per chunk with the
   metadata contract populated from the source's `ClassifiedItem`.

Future enhancements (deferred):
- LLM extract stage that pulls decisions/action items out of the page
- Link graph stage that records cross-page relationships
