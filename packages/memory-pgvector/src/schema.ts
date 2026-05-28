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
 * - `date` is indexed as raw text. ISO 8601 strings sort lexicographically
 *   the same as chronologically, so `sinceIso` range queries that compare
 *   as text use the index. We don't cast to timestamptz at index time —
 *   `text::timestamptz` is STABLE (depends on session DateStyle), and
 *   Postgres rejects STABLE functions in index expressions. Partial index
 *   on `metadata ? 'date'` avoids indexing rows that don't carry a date.
 */
export function buildBootstrapSql(args: {
  table: string;
  embeddingDim: number;
  /**
   * Emit row-level-security DDL (ENABLE + FORCE + tenant policies). ADR-021.
   * MUST only be true for external Postgres deployments — never for embedded
   * PGlite, where a single-user session sets no `app.tenant` GUC and FORCE RLS
   * would hide every row. Defaults false, so the bootstrap is byte-identical
   * to pre-ADR-021 for every existing install until a deployment opts in.
   */
  enableRls?: boolean;
}): string {
  const { table, embeddingDim, enableRls = false } = args;
  if (!isSafeIdentifier(table)) {
    throw new Error(`memory-pgvector: unsafe table name '${table}'`);
  }
  // `gen_random_uuid()` is in core Postgres since PG 13 (and bundled in PGlite),
  // so we don't pull in pgcrypto — PGlite doesn't ship that extension.
  const base = `
CREATE EXTENSION IF NOT EXISTS vector;

-- ADR-020 keyword projection. Postgres forbids subqueries directly inside a
-- GENERATED ALWAYS expression, so the jsonb-array → space-joined-text reduction
-- lives in this IMMUTABLE function and the generated column merely calls it.
-- (The original inline subquery form was invalid DDL and failed at CREATE TABLE
-- on real Postgres/PGlite.) Returns '' when metadata.keywords is absent or not
-- an array, so a row without enrichment yields the same tsvector as content
-- alone — preserving the ADR-020 default-equivalence guarantee.
CREATE OR REPLACE FUNCTION ${table}_kw_text(meta jsonb)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $fn$
  SELECT coalesce(
    (SELECT string_agg(kw, ' ')
     FROM jsonb_array_elements_text(
       CASE jsonb_typeof(meta->'keywords')
         WHEN 'array' THEN meta->'keywords'
         ELSE '[]'::jsonb
       END
     ) AS kw),
    ''
  )
$fn$;

CREATE TABLE IF NOT EXISTS ${table} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text,
  domain text NOT NULL DEFAULT 'work',
  workspace text,
  tenant_id uuid,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(${embeddingDim}),
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      content
      || ' ' || coalesce(metadata->>'summary', '')
      || ' ' || ${table}_kw_text(metadata)
    )
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Pre-existing installs didn't have workspace — add it idempotently.
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS workspace text;

-- ADR-021: stable tenant isolation key for external multi-tenant Postgres.
-- Nullable — embedded/single-tenant installs leave it NULL and never enable
-- RLS. The human-facing workspace slug stays; this UUID is what RLS keys on.
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- ADR-020: upgrade the tsv generated column to include summary + keywords.
-- Postgres GENERATED ALWAYS columns cannot be altered in-place; we must drop
-- and re-add. The DO block is idempotent: it only replaces the column when
-- the existing expression is the old content-only form. New tables get the
-- right definition from the CREATE TABLE above and skip this block.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = '${table}'
      AND column_name = 'tsv'
  ) AND NOT EXISTS (
    -- The generation expression lives in pg_attrdef.adbin (a pg_node_tree),
    -- NOT in pg_attribute.attgenerated (which is just the 's'/'' generation
    -- KIND). pg_get_expr must be given adbin/adrelid or it errors with
    -- "function pg_get_expr(char, oid) does not exist".
    SELECT 1
    FROM pg_catalog.pg_attrdef d
    JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE c.relname = '${table}'
      AND a.attname = 'tsv'
      AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) LIKE '%metadata%'
  ) THEN
    ALTER TABLE ${table} DROP COLUMN tsv;
    ALTER TABLE ${table} ADD COLUMN tsv tsvector
      GENERATED ALWAYS AS (
        to_tsvector('english',
          content
          || ' ' || coalesce(metadata->>'summary', '')
          || ' ' || ${table}_kw_text(metadata)
        )
      ) STORED;
  END IF;
END;
$$;

-- Partial unique index scoped to (workspace, source_id). Different
-- workspaces can legitimately share a source_id (e.g. a shared Loom
-- URL ingested into two workspaces by two different Claude sessions).
-- Drop the legacy global unique index if it's still around; the composite
-- replaces it. CONCURRENTLY is incompatible with IF NOT EXISTS inside a
-- transaction block, so we let Postgres serialize DDL.
DROP INDEX IF EXISTS ${table}_source_id_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ${table}_workspace_source_id_uniq
  ON ${table} (workspace, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx
  ON ${table} USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS ${table}_tsv_gin_idx
  ON ${table} USING GIN (tsv);

CREATE INDEX IF NOT EXISTS ${table}_domain_idx
  ON ${table} (domain);

CREATE INDEX IF NOT EXISTS ${table}_workspace_idx
  ON ${table} (workspace)
  WHERE workspace IS NOT NULL;

CREATE INDEX IF NOT EXISTS ${table}_tenant_id_idx
  ON ${table} (tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ${table}_project_idx
  ON ${table} ((metadata->>'project'));

-- GIN index on the whole metadata lets us match array-valued project
-- tags via @> containment (a memory with project: ["a","b"] is
-- retrievable from a "project: a" filter).
CREATE INDEX IF NOT EXISTS ${table}_metadata_gin_idx
  ON ${table} USING GIN (metadata jsonb_path_ops);

CREATE INDEX IF NOT EXISTS ${table}_type_idx
  ON ${table} ((metadata->>'type'));

CREATE INDEX IF NOT EXISTS ${table}_source_idx
  ON ${table} ((metadata->>'source'));

CREATE INDEX IF NOT EXISTS ${table}_date_idx
  ON ${table} ((metadata->>'date'))
  WHERE metadata ? 'date';
`.trim();
  return enableRls ? `${base}\n\n${buildRlsSql(table)}` : base;
}

/**
 * Row-level-security DDL for the memory table (ADR-021). Appended to the
 * bootstrap only when `enableRls` is set — i.e. external multi-tenant Postgres.
 *
 * ENABLE + FORCE: FORCE subjects even the table owner to the policies, matching
 * the production posture where the RLS-scoped path lowers into a non-superuser
 * `app` role (see ADR-021 / przm-access `createPgPool` appRole). The isolation
 * test relies on FORCE too, since PGlite runs as the table owner.
 *
 * `NULLIF(current_setting('app.tenant', true), '')::uuid` reads the per-
 * transaction tenant GUC; the NULLIF turns an unset GUC (missing_ok → '') into
 * NULL so the predicate is simply false (zero rows) instead of raising on an
 * empty-string uuid cast. A forgotten `app.tenant` therefore fails closed.
 */
export function buildRlsSql(table: string): string {
  if (!isSafeIdentifier(table)) {
    throw new Error(`memory-pgvector: unsafe table name '${table}'`);
  }
  const guc = `NULLIF(current_setting('app.tenant', true), '')::uuid`;
  return `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ${table}_tenant_select ON ${table};
CREATE POLICY ${table}_tenant_select ON ${table}
  FOR SELECT
  USING (tenant_id = ${guc});

DROP POLICY IF EXISTS ${table}_tenant_insert ON ${table};
CREATE POLICY ${table}_tenant_insert ON ${table}
  FOR INSERT
  WITH CHECK (tenant_id = ${guc});

DROP POLICY IF EXISTS ${table}_tenant_update ON ${table};
CREATE POLICY ${table}_tenant_update ON ${table}
  FOR UPDATE
  USING (tenant_id = ${guc})
  WITH CHECK (tenant_id = ${guc});

DROP POLICY IF EXISTS ${table}_tenant_delete ON ${table};
CREATE POLICY ${table}_tenant_delete ON ${table}
  FOR DELETE
  USING (tenant_id = ${guc});
`.trim();
}

/**
 * Table name comes from config, so validate aggressively before interpolating
 * into DDL. We accept only identifiers Postgres would accept unquoted.
 */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name);
}
