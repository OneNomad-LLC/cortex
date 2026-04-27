import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "./schema.js";
import type { CacheReadResult, CacheStorage } from "./types.js";

interface CacheRow {
  payload_json: string;
  refreshed_at: string;
  failure_count: number;
  last_error: string | null;
}

class SqliteCacheStorage implements CacheStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA synchronous = NORMAL`);
    applySchema(this.db);
  }

  read(
    widgetName: string,
    workspace: string,
    cacheKey: string,
  ): CacheReadResult | null {
    const row = this.db
      .prepare(
        `SELECT payload_json, refreshed_at, failure_count, last_error
         FROM cache_widgets
         WHERE widget_name = ? AND workspace = ? AND cache_key = ?`,
      )
      .get(widgetName, workspace, cacheKey) as CacheRow | undefined;
    if (!row) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      // A poisoned row (manual edit, partial write before WAL flush, etc.)
      // shouldn't bubble up as a cache hit. Treat as miss; the wrapper
      // will recompute and overwrite with a fresh payload.
      return null;
    }
    return {
      payload,
      refreshedAt: row.refreshed_at,
      failureCount: row.failure_count,
      lastError: row.last_error,
    };
  }

  write(
    widgetName: string,
    workspace: string,
    cacheKey: string,
    payload: unknown,
    refreshedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO cache_widgets
           (widget_name, workspace, cache_key, payload_json, refreshed_at, failure_count, last_error)
         VALUES (?, ?, ?, ?, ?, 0, NULL)
         ON CONFLICT (widget_name, workspace, cache_key) DO UPDATE SET
           payload_json  = excluded.payload_json,
           refreshed_at  = excluded.refreshed_at,
           failure_count = 0,
           last_error    = NULL`,
      )
      .run(widgetName, workspace, cacheKey, JSON.stringify(payload), refreshedAt);
  }

  recordFailure(
    widgetName: string,
    workspace: string,
    cacheKey: string,
    error: string,
  ): void {
    // Increment failure_count + stash last_error on the existing row if
    // present. Phase 1 doesn't read these — they're recorded for Phase 3
    // hide-after-3 UI semantics. If no row exists yet (first attempt
    // failed before any cache write), insert a sentinel with a 'null'
    // payload placeholder so the row has a home; wrapper-side reads can
    // treat payload === null as "not yet successfully cached" without a
    // schema migration for Phase 2.
    const existing = this.db
      .prepare(
        `SELECT 1 AS x FROM cache_widgets
         WHERE widget_name = ? AND workspace = ? AND cache_key = ?`,
      )
      .get(widgetName, workspace, cacheKey);
    if (existing) {
      this.db
        .prepare(
          `UPDATE cache_widgets
           SET failure_count = failure_count + 1, last_error = ?
           WHERE widget_name = ? AND workspace = ? AND cache_key = ?`,
        )
        .run(error, widgetName, workspace, cacheKey);
    } else {
      this.db
        .prepare(
          `INSERT INTO cache_widgets
             (widget_name, workspace, cache_key, payload_json, refreshed_at, failure_count, last_error)
           VALUES (?, ?, ?, 'null', ?, 1, ?)`,
        )
        .run(widgetName, workspace, cacheKey, new Date().toISOString(), error);
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openCache(dbPath: string): CacheStorage {
  return new SqliteCacheStorage(dbPath);
}
