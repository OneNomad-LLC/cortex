import { randomUUID } from "node:crypto";
import type { Logger, RawSourceItem, SourceAdapter } from "@cortex/core";
import type { LLMRouter } from "@cortex/llm-core";
import type { Pipeline, PipelineContext } from "@cortex/pipeline-core";
import { createCodePipeline } from "@cortex/pipeline-code";
import { createConversationPipeline } from "@cortex/pipeline-conversation";
import { createDocPipeline } from "@cortex/pipeline-doc";
import { createMeetingPipeline } from "@cortex/pipeline-meeting";
import type { EngramClient } from "./clients/engram.js";

export interface SyncOptions {
  /** ISO 8601 — only fetch items changed after this. */
  sinceIso?: string;
  /** Hard cap on items processed. 0 = unlimited. */
  limit?: number;
  /** When true, run the fetch/transform/classify/pipeline pass but skip
   *  the Engram write. Useful for `cortex sync --dry-run`. */
  dryRun?: boolean;
}

export interface SyncResult {
  adapterId: string;
  fetched: number;
  transformed: number;
  classified: number;
  ingested: number;
  skipped: number;
  errors: number;
}

export interface PerItemResult {
  transformed: boolean;
  classified: boolean;
  ingested: number;
  skipped: number;
  error?: Error;
}

/**
 * Resolve the pipeline packages an adapter declared. Shared across sync,
 * stream, and webhook entry points so all three use the exact same
 * pipeline set per adapter.
 */
export function resolvePipelines(adapter: SourceAdapter): Pipeline[] {
  return adapter.pipelines.map((id) => {
    if (id === "@cortex/pipeline-code") return createCodePipeline();
    if (id === "@cortex/pipeline-conversation") return createConversationPipeline();
    if (id === "@cortex/pipeline-doc") return createDocPipeline();
    if (id === "@cortex/pipeline-meeting") return createMeetingPipeline();
    throw new Error(`Unknown pipeline '${id}'. Register it in sync.ts.`);
  });
}

/**
 * Build a pipeline context bound to a specific logger + LLM router. Used
 * by every ingestion entry point so pipelines see the same shape regardless
 * of whether they were triggered by a cron run, a file-watcher event, or
 * an inbound webhook.
 */
export function buildPipelineContext(args: {
  logger: Logger;
  traceId: string;
  signal: AbortSignal;
  llmRouter?: LLMRouter;
}): PipelineContext {
  const { logger, traceId, signal, llmRouter } = args;
  return {
    logger,
    signal,
    traceId,
    llm: {
      async complete(req) {
        if (!llmRouter) {
          throw new Error(
            "processItem: pipeline asked for LLM but no router was provided.",
          );
        }
        const res = await llmRouter.complete({
          task: req.task,
          messages: [
            ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
            { role: "user" as const, content: req.prompt },
          ],
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        return res.content;
      },
    },
  };
}

/**
 * Process one raw item end-to-end: transform → classify → each pipeline →
 * ingest (unless dryRun). Every ingestion path in Cortex funnels through
 * this so behavior stays identical across cron, stream, and webhook
 * entry points — the cost of fixing something in one place is paid once.
 */
export async function processItem(args: {
  adapter: SourceAdapter;
  raw: RawSourceItem;
  pipelines: Pipeline[];
  pipelineCtx: PipelineContext;
  engram: EngramClient;
  logger: Logger;
  dryRun?: boolean;
}): Promise<PerItemResult> {
  const { adapter, raw, pipelines, pipelineCtx, engram, logger, dryRun } = args;
  const out: PerItemResult = {
    transformed: false,
    classified: false,
    ingested: 0,
    skipped: 0,
  };

  try {
    const normalized = await adapter.transform(raw);
    out.transformed = true;
    const classified = await adapter.classify(normalized, {});
    out.classified = true;
    for (const pipeline of pipelines) {
      const memories = await pipeline.run(classified, pipelineCtx);
      for (const mem of memories) {
        if (dryRun) {
          out.skipped++;
          continue;
        }
        await engram.ingest({ content: mem.content, metadata: mem.metadata });
        out.ingested++;
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err : new Error(String(err));
    logger.warn("ingest.item_failed", {
      adapter: adapter.id,
      sourceId: raw.sourceId,
      error: out.error.message,
    });
  }

  return out;
}

/**
 * Run a single adapter's full ingestion cycle once. Called by the CLI
 * (`cortex sync <adapter-id>`) and the scheduler.
 */
export async function runSync(args: {
  adapter: SourceAdapter;
  engram: EngramClient;
  logger: Logger;
  /** Optional — pipelines that need LLM access require this. */
  llmRouter?: LLMRouter;
  opts?: SyncOptions;
}): Promise<SyncResult> {
  const { adapter, engram, logger, llmRouter } = args;
  const opts = args.opts ?? {};
  const limit = opts.limit ?? 0;

  const result: SyncResult = {
    adapterId: adapter.id,
    fetched: 0,
    transformed: 0,
    classified: 0,
    ingested: 0,
    skipped: 0,
    errors: 0,
  };

  const pipelines = resolvePipelines(adapter);
  const since = opts.sinceIso ? new Date(opts.sinceIso) : undefined;
  // One correlation id for the whole sync run — every memory emitted by
  // every pipeline invocation below stamps it, so operators can filter
  // "what did the 15:00 Confluence run ingest" in one Engram query.
  const traceId = randomUUID();
  const scopedLogger = logger.child({ traceId, adapter: adapter.id });
  scopedLogger.info("sync.run.trace", { adapter: adapter.id });

  const pipelineCtx = buildPipelineContext({
    logger: scopedLogger,
    traceId,
    signal: new AbortController().signal,
    ...(llmRouter ? { llmRouter } : {}),
  });

  for await (const raw of adapter.fetch(since)) {
    result.fetched++;
    if (limit > 0 && result.fetched > limit) {
      logger.info("sync.limit_reached", { adapter: adapter.id, limit });
      break;
    }

    const per = await processItem({
      adapter,
      raw,
      pipelines,
      pipelineCtx,
      engram,
      logger: scopedLogger,
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    if (per.transformed) result.transformed++;
    if (per.classified) result.classified++;
    result.ingested += per.ingested;
    result.skipped += per.skipped;
    if (per.error) result.errors++;
  }

  logger.info("sync.done", { ...result });
  return result;
}
