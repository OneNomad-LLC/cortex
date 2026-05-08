import { randomUUID } from "node:crypto";
import type {
  EnrichmentClient,
  EnrichmentRequest,
  EnrichmentResult,
  EnrichmentType,
  Logger,
} from "@onenomad/cortex-core";

/**
 * In-memory queue of pending enrichment requests. The server creates
 * one queue per workspace at boot. Pipelines push requests; an MCP
 * client (Pyre, Claude Desktop) pulls them via the
 * `pending_enrichment_requests` tool and posts results back via
 * `submit_enrichment_result`.
 *
 * Queue is intentionally process-local — no Redis, no SQLite. Cortex
 * 0.2 ships a single-node enrichment plane; cross-node coordination
 * is a v0.3 concern. Outstanding requests at shutdown are dropped
 * (and their pipeline calls fall back to raw storage).
 */
export interface QueuedEnrichmentRequest {
  /** Server-generated identifier handed back via `submit_enrichment_result`. */
  id: string;
  /** When the request was queued. */
  enqueuedAt: string;
  request: EnrichmentRequest;
}

interface PendingEntry {
  queued: QueuedEnrichmentRequest;
  resolve: (result: EnrichmentResult | null) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface EnrichmentQueueOptions {
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /** Max pending requests at any moment. Default 200. */
  maxPending?: number;
  logger: Logger;
}

/**
 * Queue-backed implementation of `EnrichmentClient` for the case
 * where Cortex has no local LLM and a connected MCP client serves
 * as the enrichment provider.
 */
export class EnrichmentQueue implements EnrichmentClient {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly logger: Logger;

  constructor(opts: EnrichmentQueueOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxPending = opts.maxPending ?? 200;
    this.logger = opts.logger;
  }

  async enrich<T extends EnrichmentType>(
    request: EnrichmentRequest<T>,
  ): Promise<EnrichmentResult<T> | null> {
    if (this.pending.size >= this.maxPending) {
      this.logger.warn("enrichment.queue.full", { size: this.pending.size });
      return null;
    }
    const id = randomUUID();
    const queued: QueuedEnrichmentRequest = {
      id,
      enqueuedAt: new Date().toISOString(),
      request,
    };
    return new Promise<EnrichmentResult<T> | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.logger.warn("enrichment.queue.timeout", { id, type: request.type });
        // Pipelines treat null as "no enrichment available" — store raw.
        entry.resolve(null);
      }, this.timeoutMs);
      // unref so the queue doesn't keep node alive on shutdown.
      timeout.unref?.();
      this.pending.set(id, {
        queued,
        resolve: resolve as (r: EnrichmentResult | null) => void,
        reject,
        timeout,
      });
    });
  }

  /** Drain up to `limit` pending requests for the connected client. */
  drain(limit = 25): QueuedEnrichmentRequest[] {
    const out: QueuedEnrichmentRequest[] = [];
    for (const entry of this.pending.values()) {
      if (out.length >= limit) break;
      out.push(entry.queued);
    }
    return out;
  }

  /**
   * Resolve a pending request with a client-supplied result.
   * Returns true if the request id was outstanding, false if it had
   * already timed out or been answered.
   */
  submit(
    id: string,
    result: EnrichmentResult | { error: { code: string; message: string } } | null,
  ): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timeout);
    if (result && typeof result === "object" && "error" in result) {
      this.logger.warn("enrichment.queue.client_error", {
        id,
        code: result.error.code,
        message: result.error.message,
      });
      entry.resolve(null);
      return true;
    }
    entry.resolve(result);
    return true;
  }

  /** Drop every outstanding request — used on shutdown. */
  shutdown(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.resolve(null);
    }
    this.pending.clear();
  }

  size(): number {
    return this.pending.size;
  }
}

/** No-op fallback: no LLM, no client. Pipelines store raw content. */
export class NoopEnrichmentClient implements EnrichmentClient {
  async enrich(): Promise<null> {
    return null;
  }
}
