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

// ---------------------------------------------------------------------------
// Filter translator
// ---------------------------------------------------------------------------
//
// Maps a small Mongo-style filter object to a parameterized SQL fragment.
// Supported operators:
//   $eq        — col = $N
//   $in        — col IN ($N, ...)
//   $gte       — col >= $N
//   $eqOrNull  — (col = $N OR col IS NULL)      workspace backwards-compat
//   $inOrNull  — (col IS NULL OR col IN (...))   sensitivity / trust backwards-compat
//   $and       — (...) AND (...)
//   $or        — (...) OR (...)
//
// Parameters are appended into the caller-owned `values` array. The translator
// never allocates its own array — it writes into the one from the outer query
// builder so parameter numbering is always consistent across translated
// fragments that share a single query.
//
// Column expressions are trusted (they come from this file, not user input).
// The translator does not escape them.

type FilterValue = string | number | boolean | null;

interface EqFilter {
  $eq: FilterValue;
}
interface InFilter {
  $in: FilterValue[];
}
interface GteFilter {
  $gte: FilterValue;
}
interface EqOrNullFilter {
  $eqOrNull: FilterValue;
}
interface InOrNullFilter {
  $inOrNull: FilterValue[];
}
interface AndFilter {
  $and: FilterNode[];
}
interface OrFilter {
  $or: FilterNode[];
}

type FilterOp =
  | EqFilter
  | InFilter
  | GteFilter
  | EqOrNullFilter
  | InOrNullFilter
  | AndFilter
  | OrFilter;

/**
 * A filter node is either:
 *   - a logical combinator ($and / $or), or
 *   - a single column → operator entry.
 *
 * Multi-key objects are treated as an implicit $and over each entry.
 */
export type FilterNode =
  | AndFilter
  | OrFilter
  | { [column: string]: FilterOp };

/**
 * Translate a FilterNode into a SQL fragment. Parameters are appended to
 * `values` in order; placeholders reference their 1-based position in that
 * array.
 *
 * Returns a SQL string (no leading WHERE keyword). Wrap in `WHERE (...)` or
 * compose with `AND` / `OR` at the call site.
 */
export function translateFilter(node: FilterNode, values: unknown[]): string {
  const push = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };

  // Logical combinators
  if ("$and" in node) {
    const parts = (node as AndFilter).$and.map((child) =>
      translateFilter(child, values),
    );
    return parts.map((p) => `(${p})`).join(" AND ");
  }
  if ("$or" in node) {
    const parts = (node as OrFilter).$or.map((child) =>
      translateFilter(child, values),
    );
    return parts.map((p) => `(${p})`).join(" OR ");
  }

  // Column-level operator(s)
  const entries = Object.entries(node) as [string, FilterOp][];
  if (entries.length === 0) {
    throw new Error("memory-pgvector/filter: empty filter node");
  }
  if (entries.length > 1) {
    // Implicit $and over multiple column entries
    const parts = entries.map(([col, op]) =>
      translateFilter({ [col]: op } as FilterNode, values),
    );
    return parts.map((p) => `(${p})`).join(" AND ");
  }

  const [col, op] = entries[0]!;

  if ("$eq" in op) {
    return `${col} = ${push((op as EqFilter).$eq)}`;
  }
  if ("$gte" in op) {
    return `${col} >= ${push((op as GteFilter).$gte)}`;
  }
  if ("$in" in op) {
    const placeholders = (op as InFilter).$in.map((v) => push(v)).join(", ");
    return `${col} IN (${placeholders})`;
  }
  if ("$eqOrNull" in op) {
    const placeholder = push((op as EqOrNullFilter).$eqOrNull);
    return `(${col} = ${placeholder} OR ${col} IS NULL)`;
  }
  if ("$inOrNull" in op) {
    const placeholders = (op as InOrNullFilter).$inOrNull
      .map((v) => push(v))
      .join(", ");
    return `(${col} IS NULL OR ${col} IN (${placeholders}))`;
  }

  throw new Error(
    `memory-pgvector/filter: unknown operator on column '${col}'`,
  );
}

// ---------------------------------------------------------------------------

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
  /** Tenant isolation key (ADR-021). NULL for embedded/single-tenant ingests. */
  tenantId?: string | null;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}): IngestQuery {
  if (!isSafeIdentifier(args.table)) {
    throw new Error(`memory-pgvector: unsafe table name '${args.table}'`);
  }
  const vec = vectorLiteral(args.embedding);
  const tenantId = args.tenantId ?? null;
  if (args.sourceId) {
    return {
      text: `
INSERT INTO ${args.table} (source_id, domain, workspace, tenant_id, content, metadata, embedding, updated_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector, now())
ON CONFLICT (workspace, source_id) WHERE source_id IS NOT NULL
DO UPDATE SET
  content    = EXCLUDED.content,
  metadata   = EXCLUDED.metadata,
  embedding  = EXCLUDED.embedding,
  domain     = EXCLUDED.domain,
  workspace  = EXCLUDED.workspace,
  tenant_id  = EXCLUDED.tenant_id,
  updated_at = now()
RETURNING id
`.trim(),
      values: [
        args.sourceId,
        args.domain,
        args.workspace,
        tenantId,
        args.content,
        JSON.stringify(args.metadata),
        vec,
      ],
    };
  }
  return {
    text: `
INSERT INTO ${args.table} (domain, workspace, tenant_id, content, metadata, embedding)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)
RETURNING id
`.trim(),
    values: [
      args.domain,
      args.workspace,
      tenantId,
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

  // Accumulate parameters for the whole query. The translator appends into
  // this array so positional placeholders are consistent across all fragments.
  const values: unknown[] = [];
  const push = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };

  // Collect individual WHERE predicate SQL strings.
  const where: string[] = [];

  if (args.search.domain !== undefined) {
    where.push(
      translateFilter({ "domain": { $eq: args.search.domain } }, values),
    );
  }
  if (args.search.workspace !== undefined) {
    // Scope to this workspace OR rows with no workspace (legacy ingests
    // predate session binding; they remain visible in every workspace
    // for backwards compat).
    where.push(
      translateFilter(
        { "workspace": { $eqOrNull: args.search.workspace } },
        values,
      ),
    );
  }
  if (args.search.project !== undefined) {
    // Match either a string-valued project OR an array that contains
    // this slug. jsonb `@>` reads "left contains right"; we wrap the
    // probe in a JSON array to cover both shapes in one predicate.
    //
    // The array-containment branch (`@> to_jsonb(ARRAY[$N::text])`) re-uses
    // the same parameter as the equality branch, so we push the value once
    // and reference the placeholder in both branches.
    const pParam = push(args.search.project);
    where.push(
      `(metadata->>'project' = ${pParam} ` +
        `OR metadata->'project' @> to_jsonb(ARRAY[${pParam}::text]))`,
    );
  }
  if (args.search.type !== undefined) {
    where.push(
      translateFilter(
        { [`metadata->>'type'`]: { $eq: args.search.type } },
        values,
      ),
    );
  }
  if (args.search.source !== undefined) {
    where.push(
      translateFilter(
        { [`metadata->>'source'`]: { $eq: args.search.source } },
        values,
      ),
    );
  }
  if (args.search.sinceIso !== undefined) {
    // metadata.date is ISO 8601 — strings sort lexicographically the same
    // as chronologically, so the text-only index on (metadata->>'date')
    // serves this range query directly. Casting to timestamptz here would
    // bypass the index; comparing as text doesn't.
    where.push(
      translateFilter(
        { [`(metadata->>'date')`]: { $gte: args.search.sinceIso } },
        values,
      ),
    );
  }
  if (args.search.maxSensitivity !== undefined) {
    // Build the set of allowed sensitivity values: all levels up to and
    // including maxSensitivity, plus rows with no sensitivity stamp
    // (NULL / absent) which we treat as "public" for backwards compat.
    const maxIdx = SENSITIVITY_LEVELS.indexOf(args.search.maxSensitivity);
    const allowed = SENSITIVITY_LEVELS.slice(0, maxIdx + 1);
    where.push(
      translateFilter(
        { [`metadata->>'sensitivity'`]: { $inOrNull: [...allowed] } },
        values,
      ),
    );
  }
  if (args.search.minTrust !== undefined) {
    // Strict exclusion: only rows whose trust meets or exceeds minTrust,
    // plus rows with no trust stamp (NULL / absent) which pass through so
    // legacy memories without a trust field remain findable.
    const minIdx = TRUST_LEVELS.indexOf(args.search.minTrust);
    const allowed = TRUST_LEVELS.slice(minIdx);
    where.push(
      translateFilter(
        { [`metadata->>'trust'`]: { $inOrNull: [...allowed] } },
        values,
      ),
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
