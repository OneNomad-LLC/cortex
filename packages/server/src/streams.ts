import { randomUUID } from "node:crypto";
import type { Logger, SourceAdapter } from "@cortex/core";
import type { LLMRouter } from "@cortex/llm-core";
import type { EngramClient } from "./clients/engram.js";
import type { HeartbeatWriter } from "./heartbeat.js";
import {
  buildPipelineContext,
  processItem,
  resolvePipelines,
} from "./sync.js";

export interface StreamWorker {
  /** Adapter id for logging / heartbeat. */
  adapterId: string;
  /** Stop the worker and tear down the upstream iterator. */
  stop(): Promise<void>;
  /** Resolves when the underlying iterator has fully drained. */
  done: Promise<void>;
}

export interface StartStreamWorkersArgs {
  adapters: readonly SourceAdapter[];
  engram: EngramClient;
  llmRouter?: LLMRouter;
  heartbeat?: HeartbeatWriter;
  logger: Logger;
}

/**
 * Start a long-running stream worker for every adapter that implements
 * `stream()`. Each worker consumes its adapter's async iterable, routes
 * items through the shared processItem helper, and loops until told to
 * stop or the iterator ends.
 *
 * Critically, adapters with a `fetch()`-based cron schedule can ALSO
 * implement `stream()` — the two paths are additive, not exclusive. That
 * matches reality: you want Obsidian's file watcher for "just saved"
 * events AND a periodic walk to pick up anything the watcher missed
 * (dropped fs events are common during editor saves).
 */
export function startStreamWorkers(
  args: StartStreamWorkersArgs,
): StreamWorker[] {
  const workers: StreamWorker[] = [];
  for (const adapter of args.adapters) {
    if (typeof adapter.stream !== "function") continue;
    workers.push(spawnWorker(adapter, args));
  }
  return workers;
}

function spawnWorker(
  adapter: SourceAdapter,
  args: StartStreamWorkersArgs,
): StreamWorker {
  const controller = new AbortController();
  const scoped = args.logger.child({ adapter: adapter.id, via: "stream" });
  const pipelines = resolvePipelines(adapter);

  const done = (async () => {
    scoped.info("stream.begin");
    const iter = adapter.stream!({ signal: controller.signal, logger: scoped });
    try {
      for await (const raw of iter) {
        if (controller.signal.aborted) break;
        // Each streamed item gets its own trace id — the user action that
        // triggered the save/push is a distinct event from the last one,
        // so the correlation id should reset per item rather than be
        // shared by the whole stream session.
        const traceId = randomUUID();
        const itemLogger = scoped.child({ traceId });
        const pipelineCtx = buildPipelineContext({
          logger: itemLogger,
          traceId,
          signal: controller.signal,
          ...(args.llmRouter ? { llmRouter: args.llmRouter } : {}),
        });

        const per = await processItem({
          adapter,
          raw,
          pipelines,
          pipelineCtx,
          engram: args.engram,
          logger: itemLogger,
        });

        if (args.heartbeat) {
          // Stream worker shares the "adapter run" counters — a streamed
          // item looks the same to `cortex status` as one ingested by a
          // cron run.
          args.heartbeat.registerAdapter(adapter.id, undefined);
          args.heartbeat.markStreamItem(adapter.id, {
            ingested: per.ingested,
            errors: per.error ? 1 : 0,
          });
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        scoped.error("stream.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      scoped.info("stream.end");
    }
  })();

  return {
    adapterId: adapter.id,
    async stop() {
      controller.abort();
      await done;
    },
    done,
  };
}
