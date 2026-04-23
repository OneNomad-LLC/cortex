# @onenomad/cortex-pipeline-meeting

Three-pass meeting transcript extraction pipeline.

Per [ADR-004] model routing:

1. **Pass 1 — structural** (`task: structural`)
   Local model extracts JSON structure: participants, topics, decisions,
   action items, direct quotes.
2. **Pass 2 — synthesis** (`task: synthesis`)
   Quality-critical model merges structure with retrieved project
   context; rewrites action items with owners + implicit due dates.
3. **Pass 3 — brief** (`task: brief`)
   Local model generates a human-facing markdown brief.

Output: one memory per decision, one per action item, one for the full
brief, plus transcript chunks. All share the same `source_id` (via
`#suffix`) so Engram dedups re-runs.

Prompts live in `src/prompts/` as markdown — see
[ADR-007](../../docs/DECISIONS.md#adr-007). Edit them, re-run the
fixture harness, iterate without touching code.

## Fixtures

`tests/fixtures/*.txt` — sanitized sample transcripts for golden
testing. The harness runs all three passes against a stub LLM that
records calls + replays fixture responses, proving the prompt plumbing
and shape of the multi-memory output.
