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
`;

export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}
