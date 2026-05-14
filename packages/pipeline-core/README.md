# @onenomad/cortex-pipeline-core

Generic multi-stage pipeline framework. Specific pipelines
(`pipeline-meeting`, `pipeline-doc`, `pipeline-code`) build on this.

Exports:

- `Pipeline<Input, Output>` — interface every concrete pipeline implements
- `PipelineStage<In, Out>` — one step in a pipeline
- `runPipeline` — runs stages in sequence with context + logging

Current state: interfaces and stubs only. Real runner arrives with
`pipeline-meeting` in Phase 3.
