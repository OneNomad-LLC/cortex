# @onenomad/cortex-pipeline-conversation

Conversation pipeline. Each `ClassifiedItem` input represents a
thread — Slack thread, email chain, Discord topic — already flattened
into newline-separated `Speaker: message` lines. The pipeline emits:

- One **conversation** memory per thread (full transcript).
- Up to N **quote** memories pulled from the thread when the message
  count exceeds a threshold (helps retrieval surface specific
  statements rather than always returning the whole thread).
- Optional per-day group memories when a thread spans many days.

No LLM calls in v1 — the splitter is deterministic. Future enhancement:
run an `extract` pass to pull out decisions/action items the same way
`pipeline-meeting` does.

Consumed by `@onenomad/cortex-adapter-slack`. Future consumers: Discord, Teams,
email adapters.
