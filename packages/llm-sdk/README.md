# @onenomad/cortex-llm-sdk

Shared building blocks for provider packages. Use these so every provider
handles retries, timeouts, and OpenAI-compatible wire formats the same way.

Exports:

- `BaseLLMProvider` — abstract class with default `init`/`healthCheck`/`shutdown`
- `OpenAICompatibleProvider` — base class for any OpenAI-compatible endpoint
  (OpenRouter, OpenAI itself, Anthropic's OpenAI-compat endpoint, Gemini's
  OpenAI-compat endpoint, Fireworks, Together, etc.)
- `withRetry` — exponential backoff helper
- `httpFetch` — small `fetch` wrapper with timeout + typed error mapping
