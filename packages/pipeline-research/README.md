# @onenomad/cortex-pipeline-research

Two-pass research pipeline. Given a `{topic, retrievedContext}` input
produces:

- One `reference` memory with a synthesized brief.
- N `reference` memories — one per distinct finding/fact extracted
  from retrieved context + the topic.

Pass 1 ("extract") pulls structured facts from retrieved memories
using the LLM router's `structural` task binding. Pass 2 ("brief")
synthesizes a markdown brief using the `brief` task binding.

Unlike `pipeline-meeting` this pipeline doesn't have a `source` —
the user's topic IS the source. The `source_id` is derived from the
topic so re-running `research("same topic")` updates rather than
duplicates.

See ADR-011 for the shape and ADR-002 for the `reference` cognitive
layer intent.
