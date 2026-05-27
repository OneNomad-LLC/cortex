/**
 * Keywords extractor (ADR-020).
 *
 * Produces `metadata.keywords` — an array of domain terms, acronyms,
 * product names, and jargon extracted from the content.
 * Prompt: packages/server/src/enrichment/prompts/keywords.md (ADR-007).
 * Off by default; opt-in via `extractors.keywords.enabled: true` in cortex.yaml.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { MemoryMetadata } from "@onenomad/przm-cortex-core";
import type { Extractor, ExtractorConfig, ExtractorContext } from "./extractor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(
  path.join(__dirname, "prompts", "keywords.md"),
  "utf8",
).trim();

export const keywordsExtractor: Extractor = {
  name: "keywords",

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

    let response: { content: string };
    try {
      response = await ctx.llmRouter.complete({
        task: "extract",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: trimmed },
        ],
        maxTokens: 300,
        temperature: 0,
      });
    } catch (err) {
      ctx.logger.warn("extractor.keywords.llm_failed", {
        error: err instanceof Error ? err.message : String(err),
        traceId: ctx.traceId,
        contentChars: trimmed.length,
      });
      return {};
    }

    // Strip markdown fence if the model added one.
    const cleaned = response.content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      ctx.logger.warn("extractor.keywords.parse_failed", {
        error: err instanceof Error ? err.message : String(err),
        traceId: ctx.traceId,
        preview: cleaned.slice(0, 200),
      });
      return {};
    }

    if (!Array.isArray(parsed)) return {};

    const keywords: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item.trim().length > 0) {
        keywords.push(item.trim());
      }
    }

    if (keywords.length === 0) return {};
    return { keywords };
  },
};
