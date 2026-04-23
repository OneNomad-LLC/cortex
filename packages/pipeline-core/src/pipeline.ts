import type { ClassifiedItem, MemoryMetadata } from "@onenomad/cortex-core";

/**
 * Pipelines take classified items and emit one or more memories to ingest
 * into Engram. A pipeline is a package id (e.g., "@onenomad/cortex-pipeline-meeting")
 * that adapters declare via `SourceAdapter.pipelines`.
 */
export interface Pipeline<Input = ClassifiedItem, Output = PipelineMemory> {
  readonly id: string;
  readonly version: string;

  run(input: Input, ctx: PipelineContext): Promise<Output[]>;
}

export interface PipelineMemory {
  /** Content to ingest into Engram. */
  content: string;
  metadata: MemoryMetadata;
}

/**
 * What a pipeline needs. Mirror of AdapterContext, but scoped for pure-ish
 * processing (no fetching side effects).
 */
export interface PipelineContext {
  logger: {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  llm: {
    complete(args: {
      task: string;
      prompt: string;
      system?: string;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }): Promise<string>;
  };
  signal: AbortSignal;
  /**
   * Correlation id for the operation that invoked this pipeline. Pipelines
   * stamp it on every emitted memory so operators can trace ingestion
   * end-to-end.
   */
  traceId?: string;
}

/**
 * A pipeline built from a chain of stages. Kept minimal; real
 * implementations will extend with error recovery, partial-success handling,
 * and instrumentation.
 */
export interface PipelineStage<In, Out> {
  readonly name: string;
  run(input: In, ctx: PipelineContext): Promise<Out>;
}

export async function runStages<A, B>(
  input: A,
  stages: readonly [PipelineStage<A, B>],
  ctx: PipelineContext,
): Promise<B>;
export async function runStages<A, B, C>(
  input: A,
  stages: readonly [PipelineStage<A, B>, PipelineStage<B, C>],
  ctx: PipelineContext,
): Promise<C>;
export async function runStages<A, B, C, D>(
  input: A,
  stages: readonly [
    PipelineStage<A, B>,
    PipelineStage<B, C>,
    PipelineStage<C, D>,
  ],
  ctx: PipelineContext,
): Promise<D>;
export async function runStages(
  input: unknown,
  stages: readonly PipelineStage<unknown, unknown>[],
  ctx: PipelineContext,
): Promise<unknown> {
  let current: unknown = input;
  for (const stage of stages) {
    const started = Date.now();
    try {
      current = await stage.run(current, ctx);
      ctx.logger.debug("pipeline.stage.ok", {
        stage: stage.name,
        ms: Date.now() - started,
      });
    } catch (err) {
      ctx.logger.error("pipeline.stage.failed", {
        stage: stage.name,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  return current;
}
