/**
 * Summary extractor (ADR-020).
 *
 * Produces `metadata.summary` — a 1–3 sentence gist of the content.
 * Prompt: packages/server/src/enrichment/prompts/summary.md (ADR-007).
 * Off by default; opt-in via `extractors.summary.enabled: true` in cortex.yaml.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { MemoryMetadata } from "@onenomad/przm-cortex-core";
import type { Extractor, ExtractorConfig, ExtractorContext } from "./extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(
  path.join(__dirname, "prompts", "summary.md"),
  "utf8",
).trim();

export const summaryExtractor: Extractor = {
  name: "summary",

  enabled(config: ExtractorConfig | undefined): boolean {
    return config?.enabled === true;
  },

  async run(
    content: string,
    ctx: ExtractorContext,
  ): Promise<Partial<MemoryMetadata>> {
    const maxChars = ctx.maxInputChars ?? 4096;
    const trimmed =
      content.length > maxChars
        ? content.slice(0, maxChars) + "\n\n[truncated]"
        : content;

    if (trimmed.trim().length < 80) return {};

    try {
      const response = await ctx.llmRouter.complete({
        task: "extract",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: trimmed },
        ],
        maxTokens: 200,
        temperature: 0,
      });
      const text = response.content.trim();
      if (!text) return {};
      return { summary: text };
    } catch (err) {
      ctx.logger.warn("extractor.summary.llm_failed", {
        error: err instanceof Error ? err.message : String(err),
        traceId: ctx.traceId,
        contentChars: trimmed.length,
      });
      return {};
    }
  },
};
