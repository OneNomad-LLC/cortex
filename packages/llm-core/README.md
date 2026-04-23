# @onenomad/cortex-llm-core

Contract between pipelines and LLM providers.

Exports:

- `LLMProvider` — interface every provider package implements
- `LLMProviderFactory` — `(config) => LLMProvider`
- `LLMRequest`, `LLMResponse`, `LLMMessage` — the over-the-wire shapes
- `TaskPurpose` — declarative task labels pipelines use instead of picking
  models directly (e.g., `structural`, `synthesis`, `brief`, `classify`)
- `LLMRouter` — resolves a task + optional model override to a provider,
  manages a fallback chain, reports health

The router is what pipelines call. They never instantiate providers directly
and never pick models — that's all config-driven.
