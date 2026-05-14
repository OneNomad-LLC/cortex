# @onenomad/cortex-adapter-sdk

Shared building blocks for source adapter packages. Use these so every
adapter handles retries, rate limits, idempotency, and classification the
same way.

Exports:

- `BaseAdapter` — abstract base class with lifecycle scaffolding
- `withRetry` — exponential backoff helper
- `rateLimiter` — token-bucket limiter for outbound API calls
- `computeSourceId` — stable id helper for content-hash-based dedup
- `LLMClassifier` — default project classifier using LLM with projects.yaml
- `RuleClassifier` — for adapters that have deterministic project mappings

Stubs in this first cut — signatures with TODO bodies. Will be filled out
as real adapters need them (Phase 4+ for Loom, Phase 5 for Confluence).
