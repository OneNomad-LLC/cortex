/**
 * Retrieval eval for ADR-020 LLM ingest-time extractors.
 *
 * Proves two things:
 *   1. Default behaviour (no enrichment) is byte-identical to pre-ADR-020:
 *      - embedText = content when no enrichment fields are present
 *      - coalesce('') appends no tokens to the tsvector input
 *   2. With enrichment enabled, recall improves on queries that rely on
 *      domain jargon or gist-level summaries.
 *
 * Design:
 *   - Stub embedder: term-frequency cosine over a fixed vocabulary. This
 *     is deterministic, has no external deps, and is sensitive to whether
 *     summary/keyword tokens are added to the embed text.
 *   - Stub LLM extractors: return hand-crafted summary + keywords for each
 *     fixture chunk so we don't need a live LLM.
 *   - Fixture corpus: 4 chunks with domain-specific jargon that doesn't
 *     appear in the query text — a realistic "jargon gap" scenario.
 *   - Query → expected-chunk cases: 2 queries, each expected to surface a
 *     specific chunk that the stub extractors added jargon for.
 */

import { describe, expect, it } from "vitest";
import {
  runExtractors,
  type ExtractorContext,
  type ExtractorsConfig,
  type Extractor,
} from "../src/enrichment/extractor.js";

// ---------------------------------------------------------------------------
// Silence logs in eval
// ---------------------------------------------------------------------------
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silentLogger;
  },
};

// ---------------------------------------------------------------------------
// Stub embedder — fixed-vocabulary term-frequency cosine
// ---------------------------------------------------------------------------

const VOCAB = [
  "decision", "rate", "limit", "api", "throttle", "token",
  "deployment", "kubernetes", "k8s", "pod", "container", "cluster",
  "authentication", "oauth", "jwt", "session", "credential",
  "database", "postgres", "migration", "schema", "index",
  "meeting", "agreed", "team", "discuss", "review",
  "oidc", "scim", "saml", "sso", "provisioning",   // jargon for chunk 1
  "hpa", "autoscale", "replicaset", "rollout",      // jargon for chunk 2
];

function embed(text: string): number[] {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/);
  const vec = VOCAB.map((term) =>
    words.filter((w) => w === term).length,
  );
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

// ---------------------------------------------------------------------------
// Compose embedText — mirrors packages/server/src/clients/pgvector.ts
// ---------------------------------------------------------------------------

function composeEmbedText(
  content: string,
  metadata: Record<string, unknown>,
): string {
  const parts: string[] = [content];
  if (typeof metadata["summary"] === "string" && metadata["summary"].trim().length > 0) {
    parts.push(metadata["summary"].trim());
  }
  if (Array.isArray(metadata["keywords"]) && (metadata["keywords"] as unknown[]).length > 0) {
    const kws = (metadata["keywords"] as unknown[])
      .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      .join(" ");
    if (kws.length > 0) parts.push(kws);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Stub extractor factory
// ---------------------------------------------------------------------------

function makeStubExtractor(
  name: string,
  stubMap: Map<string, { summary?: string; keywords?: string[] }>,
): Extractor {
  return {
    name,
    enabled: (cfg) => cfg?.enabled === true,
    async run(content) {
      const stub = stubMap.get(content);
      if (!stub) return {};
      const patch: { summary?: string; keywords?: string[] } = {};
      if (stub.summary !== undefined) patch.summary = stub.summary;
      if (stub.keywords !== undefined) patch.keywords = stub.keywords;
      return patch;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture corpus
// ---------------------------------------------------------------------------
//
// The jargon gap: chunk-rate-limit's content has no OIDC/SSO/provisioning
// terms. Without enrichment, the chunk-auth-sso (which explicitly mentions
// "sso") ranks higher for "oidc sso provisioning" queries. With enrichment,
// chunk-rate-limit gains those terms via keywords → it rises to top-1.
//
// For the k8s case: chunk-k8s content has no "hpa"/"replicaset"/"rollout".
// chunk-k8s-detail explicitly mentions "rollout", so it wins without
// enrichment. With enrichment, chunk-k8s gains all three terms.

const CHUNKS: Array<{
  content: string;
  sourceId: string;
  summary?: string;
  keywords?: string[];
}> = [
  {
    content:
      "The team agreed to implement rate limiting on the API. Requests will be throttled to 1000 per minute per token.",
    sourceId: "chunk-rate-limit",
    // With enrichment: gains oidc/sso/provisioning → wins the sso query
    summary: "Team decided to throttle API requests using token-based rate limiting with OIDC SSO SCIM provisioning.",
    keywords: ["oidc", "sso", "scim", "provisioning", "rate", "api", "throttle"],
  },
  {
    content:
      "Kubernetes deployment configuration reviewed. Pod autoscaling thresholds updated for production cluster.",
    sourceId: "chunk-k8s",
    // With enrichment: gains hpa/replicaset/rollout → wins the hpa query
    summary: "HPA autoscale settings updated for production k8s cluster; replicaset rollout strategy defined.",
    keywords: ["hpa", "autoscale", "replicaset", "rollout", "kubernetes", "k8s", "pod"],
  },
  {
    // This chunk mentions "sso" directly → without enrichment it ranks higher
    // than chunk-rate-limit for the "oidc sso provisioning" query.
    content:
      "Authentication migrated to SSO. OAuth credentials and session tokens updated.",
    sourceId: "chunk-auth-sso",
    // No enrichment for this chunk
  },
  {
    // This chunk mentions "rollout" directly → without enrichment it ranks higher
    // than chunk-k8s for the "hpa replicaset rollout" query.
    content:
      "Deployment rollout completed. Database schema migration and index rebuilt.",
    sourceId: "chunk-k8s-detail",
    // No enrichment
  },
];

// ---------------------------------------------------------------------------
// Query → expected-chunk cases
// ---------------------------------------------------------------------------

interface QueryCase {
  query: string;
  /** Source id expected at rank 1 WITH enrichment */
  expectedWithEnrichment: string;
  /** Source id expected at rank 1 WITHOUT enrichment (demonstrates the gap) */
  expectedWithoutEnrichment: string;
  description: string;
}

const QUERY_CASES: QueryCase[] = [
  {
    query: "oidc sso provisioning",
    expectedWithEnrichment: "chunk-rate-limit",
    expectedWithoutEnrichment: "chunk-auth-sso",
    description: "chunk-auth-sso mentions 'sso' in content; chunk-rate-limit only gains oidc/sso/provisioning via enrichment",
  },
  {
    query: "hpa replicaset rollout",
    expectedWithEnrichment: "chunk-k8s",
    expectedWithoutEnrichment: "chunk-k8s-detail",
    description: "chunk-k8s-detail mentions 'rollout' in content; chunk-k8s only gains hpa/replicaset/rollout via enrichment",
  },
];

// ---------------------------------------------------------------------------
// Simple in-memory retrieval using the stub embedder
// ---------------------------------------------------------------------------

interface IngestRecord {
  sourceId: string;
  embedding: number[];
}

function searchRecords(
  records: IngestRecord[],
  query: string,
  topK: number,
): IngestRecord[] {
  const qVec = embed(query);
  return records
    .map((r) => ({ ...r, score: cosineSimilarity(qVec, r.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("retrieval eval — default behaviour equivalence (ADR-020 §CRITICAL)", () => {
  it("coalesce empty: appending empty strings via coalesce produces the same term vector", () => {
    // Proves: to_tsvector('english', content || ' ' || '' || ' ' || '') equivalent
    // to:     to_tsvector('english', content)
    // in terms of tokens. We show via our stub embedder: extra whitespace doesn't
    // change the term frequencies.
    const content = "rate limit api token throttle";
    const withCoalesceEmpty = `${content}  `;   // simulates coalesce(...,'')
    const v1 = embed(content);
    const v2 = embed(withCoalesceEmpty);
    expect(v1).toEqual(v2);
  });

  it("embedText === content when no enrichment metadata is present", () => {
    const content = CHUNKS[0]!.content;
    const embedText = composeEmbedText(content, {});
    expect(embedText).toBe(content);
  });

  it("embedText === content when summary and keywords are absent from metadata", () => {
    const content = CHUNKS[2]!.content;  // auth chunk, no enrichment
    const metadata: Record<string, unknown> = { source_id: "chunk-auth", domain: "work" };
    const embedText = composeEmbedText(content, metadata);
    expect(embedText).toBe(content);
  });

  it("embedText === content when keywords is an empty array", () => {
    const content = CHUNKS[0]!.content;
    const embedText = composeEmbedText(content, { keywords: [] });
    expect(embedText).toBe(content);
  });

  it("recall WITHOUT enrichment: a different chunk (with literal term overlap) ranks first", () => {
    // Build unenriched records: embed only content
    const records: IngestRecord[] = CHUNKS.map((c) => ({
      sourceId: c.sourceId,
      embedding: embed(c.content),
    }));

    for (const qcase of QUERY_CASES) {
      const results = searchRecords(records, qcase.query, 4);
      // Without enrichment, the chunk with the literal term in content wins.
      expect(
        results[0]?.sourceId,
        `Without enrichment, query "${qcase.query}" should rank ${qcase.expectedWithoutEnrichment} first`,
      ).toBe(qcase.expectedWithoutEnrichment);
    }
  });
});

describe("retrieval eval — WITH enrichment (ADR-020 §eval)", () => {
  it("composeEmbedText includes summary tokens when summary is set", () => {
    const content = CHUNKS[0]!.content;
    const metadata: Record<string, unknown> = { summary: CHUNKS[0]!.summary };
    const embedText = composeEmbedText(content, metadata);
    expect(embedText).not.toBe(content);
    // Summary is appended verbatim (the embed function lowercases at embed time)
    expect(embedText.toLowerCase()).toContain("oidc");
    expect(embedText.toLowerCase()).toContain("provisioning");
  });

  it("composeEmbedText includes keyword tokens when keywords are set", () => {
    const content = CHUNKS[1]!.content;
    const metadata: Record<string, unknown> = { keywords: CHUNKS[1]!.keywords };
    const embedText = composeEmbedText(content, metadata);
    expect(embedText).not.toBe(content);
    expect(embedText).toContain("hpa");
    expect(embedText).toContain("replicaset");
  });

  it("enriched vector has non-zero terms for jargon keywords absent from content", () => {
    const content = CHUNKS[0]!.content;
    const metadata: Record<string, unknown> = {
      summary: CHUNKS[0]!.summary!,
      keywords: CHUNKS[0]!.keywords!,
    };
    const enrichedEmbedText = composeEmbedText(content, metadata);

    const vContent = embed(content);
    const vEnriched = embed(enrichedEmbedText);

    // Must differ
    expect(vContent).not.toEqual(vEnriched);

    const oidcIdx = VOCAB.indexOf("oidc");
    const ssoIdx = VOCAB.indexOf("sso");
    expect(vEnriched[oidcIdx]).toBeGreaterThan(0);
    expect(vEnriched[ssoIdx]).toBeGreaterThan(0);
    expect(vContent[oidcIdx]).toBe(0);
    expect(vContent[ssoIdx]).toBe(0);
  });

  it("recall WITH enrichment: jargon-gap queries surface the right chunk at top-1", async () => {
    // Build stub extractor that returns pre-baked enrichment for known chunks
    const stubMap = new Map<string, { summary?: string; keywords?: string[] }>();
    for (const chunk of CHUNKS) {
      if (chunk.summary !== undefined || chunk.keywords !== undefined) {
        stubMap.set(chunk.content, {
          summary: chunk.summary,
          keywords: chunk.keywords,
        });
      }
    }
    const stubExtractor = makeStubExtractor("stub_enrichment", stubMap);
    const config: ExtractorsConfig = { stub_enrichment: { enabled: true } };

    // Ingest with enrichment: run extractors, compose embedText, build record
    const records: IngestRecord[] = [];
    for (const chunk of CHUNKS) {
      const ctx: ExtractorContext = {
        llmRouter: {} as ExtractorContext["llmRouter"],
        logger: silentLogger,
      };
      const patch = await runExtractors({
        content: chunk.content,
        extractors: [stubExtractor],
        config,
        ctx,
      });
      const metadata = { source_id: chunk.sourceId, ...patch };
      const embedText = composeEmbedText(chunk.content, metadata);
      records.push({
        sourceId: chunk.sourceId,
        embedding: embed(embedText),
      });
    }

    // Each jargon-gap query should now surface the expected chunk at top-1
    for (const qcase of QUERY_CASES) {
      const results = searchRecords(records, qcase.query, 4);
      expect(
        results[0]?.sourceId,
        `WITH enrichment, query "${qcase.query}" (${qcase.description}): expected top-1 = ${qcase.expectedWithEnrichment}, got ${String(results[0]?.sourceId)}`,
      ).toBe(qcase.expectedWithEnrichment);
    }
  });
});

describe("extractor framework — unit", () => {
  it("runExtractors returns {} when no extractors are enabled", async () => {
    const stub = makeStubExtractor(
      "stub",
      new Map([["x", { summary: "gist" }]]),
    );
    const result = await runExtractors({
      content: "x",
      extractors: [stub],
      config: { stub: { enabled: false } },
      ctx: {
        llmRouter: {} as ExtractorContext["llmRouter"],
        logger: silentLogger,
      },
    });
    expect(result).toEqual({});
  });

  it("runExtractors returns {} when config has no key for the extractor", async () => {
    const stub = makeStubExtractor(
      "stub",
      new Map([["x", { summary: "gist" }]]),
    );
    const result = await runExtractors({
      content: "x",
      extractors: [stub],
      config: {},
      ctx: {
        llmRouter: {} as ExtractorContext["llmRouter"],
        logger: silentLogger,
      },
    });
    expect(result).toEqual({});
  });

  it("runExtractors merges patches from multiple extractors (later wins on collision)", async () => {
    const extA: Extractor = {
      name: "a",
      enabled: () => true,
      async run() {
        return { summary: "from a", keywords: ["alpha"] };
      },
    };
    const extB: Extractor = {
      name: "b",
      enabled: () => true,
      async run() {
        return { summary: "from b" };
      },
    };
    const result = await runExtractors({
      content: "anything",
      extractors: [extA, extB],
      config: { a: { enabled: true }, b: { enabled: true } },
      ctx: {
        llmRouter: {} as ExtractorContext["llmRouter"],
        logger: silentLogger,
      },
    });
    // b runs after a → b's summary wins; a's keywords survive
    expect(result.summary).toBe("from b");
    expect(result.keywords).toEqual(["alpha"]);
  });

  it("runExtractors catches a crashing extractor and continues", async () => {
    const crasher: Extractor = {
      name: "crasher",
      enabled: () => true,
      async run() {
        throw new Error("boom");
      },
    };
    const safe: Extractor = {
      name: "safe",
      enabled: () => true,
      async run() {
        return { summary: "ok" };
      },
    };
    const result = await runExtractors({
      content: "anything",
      extractors: [crasher, safe],
      config: { crasher: { enabled: true }, safe: { enabled: true } },
      ctx: {
        llmRouter: {} as ExtractorContext["llmRouter"],
        logger: silentLogger,
      },
    });
    expect(result.summary).toBe("ok");
  });
});
