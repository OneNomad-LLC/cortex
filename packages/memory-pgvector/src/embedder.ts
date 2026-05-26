/**
 * Cortex's local embedder.
 *
 * Wraps @huggingface/transformers with the Xenova MiniLM-L6-v2 model
 * (384-dim, ~23MB, runs on CPU). Replaces the previous design where
 * Cortex called out to an LLM provider for embeddings — Cortex is
 * now self-sufficient: pgvector + this embedder = full memory stack
 * with no external runtime deps.
 *
 * Why MiniLM-L6-v2: same model Engram uses, so any tooling that
 * compares embeddings across the two systems works without re-
 * embedding. Lightweight enough to run on a VPS without a GPU,
 * which matches Cortex's hosted-deploy story.
 *
 * Lazy-loaded — the first embed() call triggers the ~5s model load
 * + (on first run) the ~23MB download from HuggingFace. Subsequent
 * calls are sub-100ms per chunk on modern hardware.
 *
 * Engram is intentionally NOT a runtime dep here — Engram lives
 * with Pyre as per-user memory; Cortex's memory backend stays
 * entirely separate so Cortex deploys remotely as a single artifact.
 */

import type { EmbedFn } from "./types.js";

/**
 * Output dim for the bundled model. Exported so callers can pass it
 * straight to memory-pgvector's `embeddingDim` config — keeps the two
 * dimensions in lockstep (a mismatch crashes inserts at runtime).
 */
export const LOCAL_EMBEDDING_DIM = 384;

/**
 * Override the default model via this env var. Useful for
 * benchmarking different embedders without rebuilding. Format must
 * be a HuggingFace Xenova id; Cortex doesn't validate the shape
 * (transformers.js will).
 */
const MODEL_ID = process.env.PRZM_CORTEX_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";

let _extractorPromise: Promise<unknown> | null = null;

async function getExtractor(): Promise<unknown> {
  if (_extractorPromise) return _extractorPromise;
  _extractorPromise = (async () => {
    // Dynamic import so a Cortex install that never touches the
    // pgvector backend (CLI-only commands, etc.) doesn't pay the
    // ~50ms transformers.js module-load cost.
    const { pipeline } = await import("@huggingface/transformers");
    return pipeline("feature-extraction", MODEL_ID, { device: "cpu" });
  })();
  return _extractorPromise;
}

/**
 * Build an EmbedFn that uses the local Xenova model. Use this as the
 * `embed` argument to createPgVectorClient when no LLM provider is
 * configured (or when the deploy explicitly wants to avoid the
 * latency / cost of LLM-routed embeddings).
 *
 * The returned function caches nothing per-call — every text gets
 * embedded fresh. Memory-pgvector's caller is expected to do its
 * own dedupe / cache layer if needed.
 */
export function createLocalEmbedder(): EmbedFn {
  return async (text: string): Promise<number[]> => {
    if (!text || typeof text !== "string") {
      // Empty input → zero vector. Memory-pgvector validates dim
      // upstream of this so returning the right length matters more
      // than returning a meaningful vector for empty content.
      return new Array(LOCAL_EMBEDDING_DIM).fill(0);
    }
    const extractor = (await getExtractor()) as (
      input: string,
      opts: { pooling: "mean"; normalize: boolean },
    ) => Promise<{ data: Float32Array }>;
    const out = await extractor(text, { pooling: "mean", normalize: true });
    // out.data is a Float32Array; pg-vector's text encoding works
    // with regular number[]. Convert once at the boundary.
    return Array.from(out.data as Float32Array);
  };
}
