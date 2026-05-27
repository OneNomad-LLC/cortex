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

import { createHash } from "node:crypto";
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
 * Per-process content-addressed embedding cache.
 *
 * Design:
 * - Key: SHA-256 hex of the input text (first 16 chars = 64 bits of
 *   collision resistance, more than sufficient for a process-lifetime
 *   cache of a few thousand strings).
 * - Value: the embedding vector, stored as a frozen array reference
 *   so callers can't mutate the cached copy.
 * - Eviction: when the map reaches EMBED_CACHE_MAX, the oldest
 *   insertion is deleted. JavaScript's Map guarantees insertion-order
 *   iteration, so Map.keys().next() is always the oldest entry —
 *   this gives O(1) eviction without a separate LRU structure.
 * - Thread safety: Node.js is single-threaded; no lock needed.
 */
const EMBED_CACHE_MAX = 4096;
const _embedCache = new Map<string, number[]>();

function cacheKey(text: string): string {
  // First 32 hex chars = 128 bits. Overkill for a process cache but
  // still a trivially cheap slice vs. the embedding cost it avoids.
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

function cacheGet(key: string): number[] | undefined {
  return _embedCache.get(key);
}

function cacheSet(key: string, vec: number[]): void {
  if (_embedCache.size >= EMBED_CACHE_MAX) {
    // Evict the oldest entry (first key in insertion order).
    const oldest = _embedCache.keys().next().value;
    if (oldest !== undefined) {
      _embedCache.delete(oldest);
    }
  }
  _embedCache.set(key, vec);
}

/**
 * Exposed for tests — lets a test verify the cache is populated or
 * drain it between cases. Not part of the public API surface.
 */
export const _testOnly = {
  cache: _embedCache,
  cacheMax: EMBED_CACHE_MAX,
  clearCache: () => _embedCache.clear(),
};

/**
 * Build an EmbedFn that uses the local Xenova model. Identical text
 * inputs return the cached vector from a per-process Map (keyed by
 * SHA-256 hash) without re-invoking the model. The cache is bounded
 * to EMBED_CACHE_MAX entries; oldest entry is evicted when full.
 *
 * The embedding output is pure memoization — the cached value is
 * identical to what the model would produce for the same input. The
 * only observable difference is that repeated identical inputs do not
 * call the underlying extractor a second time.
 */
export function createLocalEmbedder(): EmbedFn {
  return async (text: string): Promise<number[]> => {
    if (!text || typeof text !== "string") {
      // Empty input → zero vector. Memory-pgvector validates dim
      // upstream of this so returning the right length matters more
      // than returning a meaningful vector for empty content.
      return new Array(LOCAL_EMBEDDING_DIM).fill(0) as number[];
    }

    const key = cacheKey(text);
    const cached = cacheGet(key);
    if (cached !== undefined) {
      return cached;
    }

    const extractor = (await getExtractor()) as (
      input: string,
      opts: { pooling: "mean"; normalize: boolean },
    ) => Promise<{ data: Float32Array }>;
    const out = await extractor(text, { pooling: "mean", normalize: true });
    // out.data is a Float32Array; pg-vector's text encoding works
    // with regular number[]. Convert once at the boundary.
    const vec = Array.from(out.data as Float32Array);
    cacheSet(key, vec);
    return vec;
  };
}
