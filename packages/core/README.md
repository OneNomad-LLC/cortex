# @onenomad/cortex-core

Shared types and interfaces. No I/O. No logic. Just contracts that every
adapter, pipeline, and the server rely on.

Exports:

- `SourceAdapter` — contract every source adapter implements
- `NormalizedItem`, `ClassifiedItem` — shapes that flow between adapters and
  pipelines
- `AdapterContext` — what the server injects at adapter init
- `AdapterCapabilities` — capability flags
- `MemoryMetadata` — the load-bearing metadata contract for Engram ingestion

Changes here ripple. Keep them intentional.
