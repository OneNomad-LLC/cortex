import type { MemorySearchArgs } from "./types.js";
import { SENSITIVITY_LEVELS, TRUST_LEVELS } from "./types.js";
import { isSafeIdentifier } from "./schema.js";

/**
 * pgvector accepts literal or parameter form `'[x,y,z]'`. We stringify here
 * so callers pass a normal `number[]` to the backend and never have to know
 * about the vector text format.
 */
export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.map(toFiniteFloat).join(",")}]`;
}

function toFiniteFloat(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(
      `memory-pgvector: embedding contains non-finite value (${n})`,
    );
  }
  return Number(n).toString();
}

export interface IngestQuery {
  text: string;
  values: unknown[];
}

/**
 * Build an upsert. Rows with a `sourceId` take the INSERT ... ON CONFLICT
 * path and collapse re-ingests onto the existing row. Rows without one just
 * insert (Engram's `memory_ingest` is idempotent by `source_id` too, so
 * nothing in the caller changes).
 */
export function buildIngestQuery(args: {
  table: string;
  sourceId: string | null;
  domain: string;
  workspace: string | null;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}): IngestQuery {
  if (!isSafeIdentifier(args.table)) {
    throw new Error(`memory-pgvector: unsafe table name '${args.table}'`);
  }
  const vec = vectorLiteral(args.embedding);
  if (args.sourceId) {
    return {
      text: `
INSERT INTO ${args.table} (source_id, domain, workspace, content, metadata, embedding, updated_at)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector, now())
ON CONFLICT (workspace, source_id) WHERE source_id IS NOT NULL
DO UPDATE SET
  content    = EXCLUDED.content,
  metadata   = EXCLUDED.metadata,
  embedding  = EXCLUDED.embedding,
  domain     = EXCLUDED.domain,
  workspace  = EXCLUDED.workspace,
  updated_at = now()
RETURNING id
`.trim(),
      values: [
        args.sourceId,
        args.domain,
        args.workspace,
        args.content,
        JSON.stringify(args.metadata),
        vec,
      ],
    };
  }
  return {
    text: `
INSERT INTO ${args.table} (domain, workspace, content, metadata, embedding)
VALUES ($1, $2, $3, $4::jsonb, $5::vector)
RETURNING id
`.trim(),
    values: [
      args.domain,
      args.workspace,
      args.content,
      JSON.stringify(args.metadata),
      vec,
    ],
  };
}

export interface SearchQuery {
  text: string;
  values: unknown[];
}

/**
 * Build the hybrid-search query. Two CTEs (vector + text) each return a
 * candidate set with a rank; the outer SELECT fuses them with reciprocal
 * rank fusion:
 *
 *    fused = sum(1 / (k + rank))  across (vector, text) channels
 *
 * The constant `k` (default 60) is Cormack/Clarke/Buettcher's — it tempers
 * the influence of the top-ranked candidate from any single channel. Setting
 * `k=0` recovers plain reciprocal rank; we keep 60 as the default.
 *
 * Each CTE applies the same filters, so filters act as a prefilter inside
 * each channel rather than as a post-filter on the fused output. This is the
 * behavior a caller expects — "only pages in project X" means no
 * out-of-project page ever surfaces.
 *
 * Score semantics: the returned `score` is the RRF sum, not a cosine
 * similarity. With k=60 a top-rank-in-both-channels hit scores ~0.033;
 * monotonic with relevance but not 0..1 bounded. Callers that need a
 * 0..1 score should post-normalize by dividing by the max of the batch.
 */
export function buildHybridSearchQuery(args: {
  table: string;
  queryEmbedding: number[];
  queryText: string;
  search: MemorySearchArgs;
  k?: number;
  /** Per-channel candidate limit before fusion. Default = max(limit*4, 40). */
  channelLimit?: number;
}): SearchQuery {
  if (!isSafeIdentifier(args.table)) {
    throw new Error(`memory-pgvector: unsafe table name '${args.table}'`);
  }
  const limit = args.search.limit ?? 10;
  const channelLimit = args.channelLimit ?? Math.max(limit * 4, 40);
  const k = args.k ?? 60;
  const vec = vectorLiteral(args.queryEmbedding);

  // Build the shared WHERE clause + param list, then reuse it in both CTEs.
  const values: unknown[] = [];
  const where: string[] = [];
  const push = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };

  if (args.search.domain !== undefined) {
    where.push(`domain = ${push(args.search.domain)}`);
  }
  if (args.search.workspace !== undefined) {
    // Scope to this workspace OR rows with no workspace (legacy ingests
    // predate session binding; they remain visible in every workspace
    // for backwards compat).
    const wParam = push(args.search.workspace);
    where.push(`(workspace = ${wParam} OR workspace IS NULL)`);
  }
  if (args.search.project !== undefined) {
    // Match either a string-valued project OR an array that contains
    // this slug. jsonb `@>` reads "left contains right"; we wrap the
    // probe in a JSON array to cover both shapes in one predicate.
    const pParam = push(args.search.project);
    where.push(
      `(metadata->>'project' = ${pParam} ` +
        `OR metadata->'project' @> to_jsonb(ARRAY[${pParam}::text]))`,
    );
  }
  if (args.search.type !== undefined) {
    where.push(`metadata->>'type' = ${push(args.search.type)}`);
  }
  if (args.search.source !== undefined) {
    where.push(`metadata->>'source' = ${push(args.search.source)}`);
  }
  if (args.search.sinceIso !== undefined) {
    // metadata.date is ISO 8601 — strings sort lexicographically the same
    // as chronologically, so the text-only index on (metadata->>'date')
    // serves this range query directly. Casting to timestamptz here would
    // bypass the index; comparing as text doesn't.
    where.push(`(metadata->>'date') >= ${push(args.search.sinceIso)}`);
  }
  if (args.search.maxSensitivity !== undefined) {
    // Build the set of allowed sensitivity values: all levels up to and
    // including maxSensitivity, plus rows with no sensitivity stamp
    // (NULL / absent) which we treat as "public" for backwards compat.
    const maxIdx = SENSITIVITY_LEVELS.indexOf(args.search.maxSensitivity);
    const allowed = SENSITIVITY_LEVELS.slice(0, maxIdx + 1);
    const placeholders = allowed.map((v) => push(v)).join(", ");
    where.push(
      `(metadata->>'sensitivity' IS NULL OR metadata->>'sensitivity' IN (${placeholders}))`,
    );
  }
  if (args.search.minTrust !== undefined) {
    // Strict exclusion: only rows whose trust meets or exceeds minTrust,
    // plus rows with no trust stamp (NULL / absent) which pass through so
    // legacy memories without a trust field remain findable.
    const minIdx = TRUST_LEVELS.indexOf(args.search.minTrust);
    const allowed = TRUST_LEVELS.slice(minIdx);
    const placeholders = allowed.map((v) => push(v)).join(", ");
    where.push(
      `(metadata->>'trust' IS NULL OR metadata->>'trust' IN (${placeholders}))`,
    );
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const vecParam = push(vec);
  const textParam = push(args.queryText);
  const channelLimitParam = push(channelLimit);
  const kParam = push(k);
  const outerLimitParam = push(limit);

  // Trust down-ranking: when the caller has NOT requested strict minTrust
  // exclusion, apply a small score multiplier so experimental/external rows
  // rank below approved rows when everything else is equal. A factor of 0.85
  // (≈15% penalty) is large enough to be meaningful but small enough that a
  // highly-relevant experimental row still beats a weakly-relevant approved one.
  // Rows with no trust stamp pass through at full score (backwards compat).
  const trustScoreExpr =
    args.search.minTrust === undefined
      ? `f.fused_score * CASE
           WHEN m.metadata->>'trust' IN ('experimental', 'external') THEN 0.85
           ELSE 1.0
         END`
      : `f.fused_score`;

  const text = `
WITH vec AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY embedding <=> ${vecParam}::vector) AS rnk,
         1 - (embedding <=> ${vecParam}::vector) AS sim
  FROM ${args.table}
  ${whereSql}
  ${whereSql ? "AND" : "WHERE"} embedding IS NOT NULL
  ORDER BY embedding <=> ${vecParam}::vector
  LIMIT ${channelLimitParam}
),
txt AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsv, websearch_to_tsquery('english', ${textParam})) DESC) AS rnk,
         ts_rank_cd(tsv, websearch_to_tsquery('english', ${textParam})) AS tsc
  FROM ${args.table}
  ${whereSql}
  ${whereSql ? "AND" : "WHERE"} tsv @@ websearch_to_tsquery('english', ${textParam})
  ORDER BY tsc DESC
  LIMIT ${channelLimitParam}
),
fused AS (
  SELECT id, SUM(score) AS fused_score FROM (
    SELECT id, 1.0 / (${kParam} + rnk) AS score FROM vec
    UNION ALL
    SELECT id, 1.0 / (${kParam} + rnk) AS score FROM txt
  ) s
  GROUP BY id
)
SELECT m.id::text AS id,
       m.content,
       m.metadata,
       m.created_at,
       ${trustScoreExpr} AS score
FROM fused f
JOIN ${args.table} m ON m.id = f.id
ORDER BY score DESC
LIMIT ${outerLimitParam}
`.trim();

  return { text, values };
}

export interface DeleteQuery {
  text: string;
  values: unknown[];
}

/**
 * Build a delete by source_id OR by id. Returns the deleted row count
 * via `RETURNING id` — pg wraps it as rows.length.
 */
export function buildDeleteQuery(args: {
  table: string;
  sourceId?: string;
  id?: string;
}): DeleteQuery {
  if (!isSafeIdentifier(args.table)) {
    throw new Error(`memory-pgvector: unsafe table name '${args.table}'`);
  }
  if (args.sourceId && args.id) {
    throw new Error(
      "memory-pgvector: delete accepts sourceId OR id, not both",
    );
  }
  if (args.sourceId) {
    return {
      text: `DELETE FROM ${args.table} WHERE source_id = $1 RETURNING id`,
      values: [args.sourceId],
    };
  }
  if (args.id) {
    return {
      text: `DELETE FROM ${args.table} WHERE id = $1::uuid RETURNING id`,
      values: [args.id],
    };
  }
  throw new Error("memory-pgvector: delete requires sourceId or id");
}

/**
 * Health check — cheap, no locks. Confirms the extension + table exist and
 * returns an ANALYZE-based row estimate. Exact COUNT(*) is a seq scan on a
 * growing table; `reltuples` is instant and close enough for a health ping.
 * Callers needing exact counts should run their own query.
 */
export function buildHealthQuery(table: string): string {
  if (!isSafeIdentifier(table)) {
    throw new Error(`memory-pgvector: unsafe table name '${table}'`);
  }
  return `
SELECT
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has_vector,
  (SELECT to_regclass('${table}') IS NOT NULL) AS has_table,
  COALESCE(
    (SELECT reltuples::bigint FROM pg_class WHERE relname = '${table}'),
    0
  ) AS row_count
`.trim();
}
