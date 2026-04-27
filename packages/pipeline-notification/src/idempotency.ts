import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Idempotency store for notification triggers. Records that a trigger
 * fired with a particular `triggerId` so a daemon restart, a clock
 * skew, or a retry doesn't double-send. Backed by SQLite (same pattern
 * as @onenomad/cortex-cache-sqlite — node:sqlite, single file, WAL).
 *
 * `triggerId` shape (caller's responsibility):
 *   - morning-brief:<YYYY-MM-DD>
 *   - eod-capture:<YYYY-MM-DD>
 *   - pre-meeting:<eventId>
 *
 * The keying is intentionally per-trigger-flavor + per-natural-window,
 * not "any send within last N minutes" — that lets the dispatcher
 * dedupe deterministically without timing windows.
 */

export interface IdempotencyStore {
  /**
   * Has `triggerId` been recorded already? Returns the prior fire
   * time (ISO) when seen, or null when fresh.
   */
  hasFired(triggerId: string): string | null;

  /**
   * Mark `triggerId` as fired. Idempotent — calling twice with the
   * same id keeps the FIRST timestamp (so retry counters etc. don't
   * silently rewrite history).
   */
  recordFire(triggerId: string, firedAt: string, payloadHash: string): void;

  close(): void;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notifications_sent (
  trigger_id     TEXT NOT NULL PRIMARY KEY,
  fired_at       TEXT NOT NULL,
  payload_hash   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notif_fired
  ON notifications_sent (fired_at);
`;

class SqliteIdempotency implements IdempotencyStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA synchronous = NORMAL`);
    this.db.exec(SCHEMA_SQL);
  }

  hasFired(triggerId: string): string | null {
    const row = this.db
      .prepare(`SELECT fired_at FROM notifications_sent WHERE trigger_id = ?`)
      .get(triggerId) as { fired_at: string } | undefined;
    return row?.fired_at ?? null;
  }

  recordFire(triggerId: string, firedAt: string, payloadHash: string): void {
    // INSERT OR IGNORE — first write wins. A second call with the
    // same triggerId is a no-op so the original fired_at survives.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications_sent
           (trigger_id, fired_at, payload_hash)
         VALUES (?, ?, ?)`,
      )
      .run(triggerId, firedAt, payloadHash);
  }

  close(): void {
    this.db.close();
  }
}

export function openIdempotencyStore(dbPath: string): IdempotencyStore {
  return new SqliteIdempotency(dbPath);
}
