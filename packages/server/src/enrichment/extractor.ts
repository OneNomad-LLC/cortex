/**
 * Extractor framework (ADR-020).
 *
 * An Extractor is a named, opt-in ingest-time LLM enrichment step.
 * Each extractor receives the chunk content + a lightweight context and
 * returns a Partial<MemoryMetadata> that is merged onto the memory's
 * metadata before ingest. Extractors are:
 *   - gated on LLM-provider presence (same as extractStructuredItems)
 *   - individually opt-in via the `extractors` block in cortex.yaml
 *   - off by default
 *
 * Design is deliberately minimal: any single-LLM-call annotation that
 * produces metadata fields can be added without reshaping the interface.
 */

import type { LLMRouter } from "@onenomad/przm-cortex-llm-core";
import type { Logger, MemoryMetadata } from "@onenomad/przm-cortex-core";

/**
 * Per-extractor opt-in config shape. Every extractor has at least an
 * `enabled` flag; individual extractors may add their own fields.
 */
export interface ExtractorConfig {
  enabled: boolean;
}

/**
 * Runtime context passed to each extractor's `run()` call.
 */
export interface ExtractorContext {
  llmRouter: LLMRouter;
  logger: Logger;
  /** Trace id propagated from the parent ingest operation. */
  traceId?: string;
  /** Hard ceiling on input chars sent to the LLM (default: 4096). */
  maxInputChars?: number;
}

/**
 * The extractor interface. Implementations live in this directory, one
 * file per extractor. Prompts live as .md files in ./prompts/ per ADR-007.
 */
export interface Extractor<TCfg extends ExtractorConfig = ExtractorConfig> {
  /**
   * Stable identifier. Used as the key in the `extractors` config block
   * and in log lines.
   */
  readonly name: string;

  /**
   * Returns true when this extractor should run, given the resolved
   * config for the `extractors` block. Receives the per-extractor slice
   * from `ExtractorsConfig[name]`, which may be undefined when the operator
   * hasn't configured it (treat as disabled).
   */
  enabled(config: TCfg | undefined): boolean;

  /**
   * Run the extractor against `content`. Returns a Partial<MemoryMetadata>
   * — only the fields this extractor sets. The runner merges results from
   * all enabled extractors.
   *
   * Must never throw to the caller: swallow errors internally, log a warning,
   * and return `{}` so a single extractor failure can't abort the ingest.
   */
  run(
    content: string,
    ctx: ExtractorContext,
  ): Promise<Partial<MemoryMetadata>>;
}

// ---------------------------------------------------------------------------
// Extractor config block (lives in cortexConfigSchema as `extractors`)
// ---------------------------------------------------------------------------

/**
 * The `extractors` block in cortex.yaml. Each key is an extractor name;
 * value carries at least `enabled`. Off by default — a missing key means
 * disabled.
 */
export interface ExtractorsConfig {
  summary?: ExtractorConfig;
  keywords?: ExtractorConfig;
  [key: string]: ExtractorConfig | undefined;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run all registered extractors that are enabled according to `config`,
 * merge their Partial<MemoryMetadata> results (later extractors win on
 * collision), and return the merged patch.
 *
 * Returns `{}` when:
 *   - `config` has no entries or all extractors are disabled
 *   - `extractors` list is empty
 *   - every extractor's `run()` returned `{}`
 *
 * This means default behavior (no extractors configured) is byte-identical
 * to the pre-ADR-020 path.
 */
export async function runExtractors(args: {
  content: string;
  extractors: readonly Extractor[];
  config: ExtractorsConfig;
  ctx: ExtractorContext;
}): Promise<Partial<MemoryMetadata>> {
  const { content, extractors, config, ctx } = args;
  let merged: Partial<MemoryMetadata> = {};

  for (const extractor of extractors) {
    const extCfg = config[extractor.name];
    if (!extractor.enabled(extCfg)) continue;

    try {
      const patch = await extractor.run(content, ctx);
      merged = { ...merged, ...patch };
    } catch (err) {
      // A crash in run() that wasn't caught internally — shouldn't happen,
      // but belt-and-suspenders: log and continue.
      ctx.logger.warn("extractor.run.unexpected_error", {
        extractor: extractor.name,
        error: err instanceof Error ? err.message : String(err),
        traceId: ctx.traceId,
      });
    }
  }

  return merged;
}
