import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cache_widgets (
  widget_name     TEXT NOT NULL,
  workspace       TEXT NOT NULL,
  cache_key       TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  refreshed_at    TEXT NOT NULL,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  PRIMARY KEY (widget_name, workspace, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_cache_workspace
  ON cache_widgets (workspace, refreshed_at);

CREATE TABLE IF NOT EXISTS cache_meta (
  widget_name           TEXT NOT NULL,
  workspace             TEXT NOT NULL,
  last_refresh_attempt  TEXT,
  last_refresh_success  TEXT,
  PRIMARY KEY (widget_name, workspace)
);

-- Persistent background-job registry. The in-memory JobRegistry in the
-- server is the source of truth while the process is alive; this table
-- mirrors every status transition so a restart doesn't strand
-- in-flight or recently-completed jobs (the dashboard's Jobs page
-- needs them for the "last 24h" view, and a kb_job_status poll across
-- a restart should still find the job).
--
-- Stores:
--   - job_id        UUID issued at create()
--   - type          tool kind that spawned the job (ingest_repo, ingest_url, ...)
--   - workspace     workspace slug the job is scoped to ("" for unbound)
--   - status        queued | running | completed | failed
--   - progress_json free-form per-handler progress patch (JSON-encoded)
--   - error         message on failure
--   - created_at    epoch ms (PK ordering for LRU eviction)
--   - started_at    epoch ms when status → running
--   - finished_at   epoch ms when status → completed | failed
CREATE TABLE IF NOT EXISTS cache_jobs (
  job_id        TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  workspace     TEXT NOT NULL,
  status        TEXT NOT NULL,
  progress_json TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);

CREATE INDEX IF NOT EXISTS cache_jobs_workspace_idx
  ON cache_jobs (workspace, created_at DESC);

CREATE INDEX IF NOT EXISTS cache_jobs_status_idx
  ON cache_jobs (status, created_at DESC);

-- Dashboard session shadow. The in-memory sessionStates map in the
-- server is the live source of truth; this table mirrors every
-- dashboard-bound session (raw-token path AND GitHub OAuth path) so a
-- restart doesn't kick every browser back to the login screen.
--
-- Only sessions with dashboardScopes (i.e. authenticated dashboard
-- users) are persisted. Plain MCP sessions stay in-memory only;
-- nothing to recover for them.
--
-- Columns:
--   session_id           dash_<uuid> cookie value
--   workspace            workspace slug ("" for unbound)
--   scopes_json          JSON array of scopes ["admin"] | ["read","ingest"] | ...
--   token_label          normalized label when authenticated by token-paste; null for OAuth
--   github_login         github username when authenticated by OAuth; null otherwise
--   github_user_id       stable numeric github id (lets us tell two matts apart over time)
--   github_avatar_url    for whoami rendering
--   github_access_token  raw OAuth token; Slice B repos API needs it to call GitHub
--   created_at           epoch ms when first minted
--   expires_at           epoch ms; sessions auto-evict at this point
--   last_seen_at         epoch ms; bumps on every cookie hit
CREATE TABLE IF NOT EXISTS cache_sessions (
  session_id          TEXT PRIMARY KEY,
  workspace           TEXT NOT NULL,
  scopes_json         TEXT NOT NULL,
  token_label         TEXT,
  github_login        TEXT,
  github_user_id      INTEGER,
  github_avatar_url   TEXT,
  github_access_token TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS cache_sessions_expires_idx
  ON cache_sessions (expires_at);
`;

export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}
