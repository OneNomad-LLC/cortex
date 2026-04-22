/**
 * Schema bootstrap. One big idempotent DDL block — run on every boot, cheap
 * after the first time since every `CREATE ... IF NOT EXISTS` no-ops.
 *
 * Design notes:
 * - `embedding` dimension is parameter-driven. pgvector fixes dimension at
 *   column-definition time, so swapping embedding models later requires a
 *   one-time migration that this bootstrap can't do for you. Pick once.
 * - `tsv` is a STORED generated column. That costs disk but means ingest
 *   doesn't have to compute tsvector separately, and the GIN index can be
 *   built without custom triggers.
 * - JSONB expression indexes on the hot filters (project, type, source,
 *   domain) keep the prefilter stage cheap when the candidate set is big.
 * - `date` is cast to timestamptz at index time so `sinceIso` range queries
 *   use the index. Partial index on `metadata ? 'date'` avoids indexing the
 *   many rows that don't carry a date.
 */
export function buildBootstrapSql(args: {
  table: string;
  embeddingDim: number;
}): string {
  const { table, embeddingDim } = args;
  if (!isSafeIdentifier(table)) {
    throw new Error(`memory-pgvector: unsafe table name '${table}'`);
  }
  return `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS ${table} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text,
  domain text NOT NULL DEFAULT 'work',
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(${embeddingDim}),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ${table}_source_id_uniq
  ON ${table} (source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx
  ON ${table} USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS ${table}_tsv_gin_idx
  ON ${table} USING GIN (tsv);

CREATE INDEX IF NOT EXISTS ${table}_domain_idx
  ON ${table} (domain);

CREATE INDEX IF NOT EXISTS ${table}_project_idx
  ON ${table} ((metadata->>'project'));

CREATE INDEX IF NOT EXISTS ${table}_type_idx
  ON ${table} ((metadata->>'type'));

CREATE INDEX IF NOT EXISTS ${table}_source_idx
  ON ${table} ((metadata->>'source'));

CREATE INDEX IF NOT EXISTS ${table}_date_idx
  ON ${table} (((metadata->>'date')::timestamptz))
  WHERE metadata ? 'date';
`.trim();
}

/**
 * Table name comes from config, so validate aggressively before interpolating
 * into DDL. We accept only identifiers Postgres would accept unquoted.
 */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name);
}
