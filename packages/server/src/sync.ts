import type { Logger, SourceAdapter } from "@cortex/core";
import type { LLMRouter } from "@cortex/llm-core";
import { createCodePipeline } from "@cortex/pipeline-code";
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

/**
 * Run a single adapter's full ingestion cycle once. Called by the CLI
 * (`cortex sync <adapter-id>`) and — eventually — the scheduler.
 *
 * Pipelines are looked up by the id the adapter declared. Keeping this
 * map inline means adding a new pipeline package is one import here
 * plus whatever the adapter lists; no magic registry.
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

  // Build the pipelines this adapter declared. Add new pipelines here
  // when their packages land.
  const pipelines = adapter.pipelines.map((id) => {
    if (id === "@cortex/pipeline-code") return createCodePipeline();
    if (id === "@cortex/pipeline-doc") return createDocPipeline();
    if (id === "@cortex/pipeline-meeting") return createMeetingPipeline();
    throw new Error(`Unknown pipeline '${id}'. Register it in sync.ts.`);
  });

  const since = opts.sinceIso ? new Date(opts.sinceIso) : undefined;

  const pipelineCtx = {
    logger,
    signal: new AbortController().signal,
    llm: {
      async complete(req: {
        task: string;
        prompt: string;
        system?: string;
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
      }): Promise<string> {
        if (!llmRouter) {
          throw new Error(
            "sync: pipeline asked for LLM but no router was provided " +
              "to runSync. Pass `llmRouter` in the args.",
          );
        }
        const res = await llmRouter.complete({
          task: req.task,
          messages: [
            ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
            { role: "user" as const, content: req.prompt },
          ],
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        return res.content;
      },
    },
  };

  for await (const raw of adapter.fetch(since)) {
    result.fetched++;
    if (limit > 0 && result.fetched > limit) {
      logger.info("sync.limit_reached", { adapter: adapter.id, limit });
      break;
    }

    try {
      const normalized = await adapter.transform(raw);
      result.transformed++;

      const classified = await adapter.classify(normalized, {});
      result.classified++;

      for (const pipeline of pipelines) {
        const memories = await pipeline.run(classified, pipelineCtx);
        for (const mem of memories) {
          if (opts.dryRun) {
            result.skipped++;
            continue;
          }
          await engram.ingest({ content: mem.content, metadata: mem.metadata });
          result.ingested++;
        }
      }
    } catch (err) {
      result.errors++;
      logger.warn("sync.item_failed", {
        adapter: adapter.id,
        sourceId: raw.sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("sync.done", { ...result });
  return result;
}
