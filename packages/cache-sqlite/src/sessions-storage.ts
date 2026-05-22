/**
 * SQLite-backed persistence for dashboard sessions. Parallel to
 * `jobs-storage.ts` — same DB file, separate table (`cache_sessions`).
 *
 * Why a write-through shadow rather than relying on signed cookies:
 *   - The dashboard cookie holds only the session id (`dash_<uuid>`),
 *     not the bearer claims. The actual scopes + tokenLabel +
 *     github identity live server-side. A restart without persistence
 *     means every browser sees a 401 on the next request.
 *   - Slice B needs the raw github access token to call GitHub on
 *     behalf of the logged-in user; keeping that in memory only would
 *     mean re-running the device flow after every restart.
 *
 * The token is stored at rest. Operators should treat the SQLite file
 * (default `~/.cortex/dashboard-cache.db`) accordingly — keep it out
 * of backups, encrypt the volume on shared hosts, etc. Same hygiene as
 * `~/.cortex/github-token.json` from the CLI flow.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "./schema.js";
import type { SessionRow, SessionsStorage } from "./types.js";

interface DbSessionRow {
  session_id: string;
  workspace: string;
  scopes_json: string;
  token_label: string | null;
  github_login: string | null;
  github_user_id: number | null;
  github_avatar_url: string | null;
  github_access_token: string | null;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

function rowFromDb(row: DbSessionRow): SessionRow {
  return {
    sessionId: row.session_id,
    workspace: row.workspace,
    scopesJson: row.scopes_json,
    tokenLabel: row.token_label,
    githubLogin: row.github_login,
    githubUserId: row.github_user_id,
    githubAvatarUrl: row.github_avatar_url,
    githubAccessToken: row.github_access_token,
    createdAtMs: row.created_at,
    expiresAtMs: row.expires_at,
    lastSeenAtMs: row.last_seen_at,
  };
}

class SqliteSessionsStorage implements SessionsStorage {
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

  upsert(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO cache_sessions
           (session_id, workspace, scopes_json, token_label,
            github_login, github_user_id, github_avatar_url,
            github_access_token, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           workspace           = excluded.workspace,
           scopes_json         = excluded.scopes_json,
           token_label         = excluded.token_label,
           github_login        = excluded.github_login,
           github_user_id      = excluded.github_user_id,
           github_avatar_url   = excluded.github_avatar_url,
           github_access_token = excluded.github_access_token,
           expires_at          = excluded.expires_at,
           last_seen_at        = excluded.last_seen_at`,
      )
      .run(
        row.sessionId,
        row.workspace,
        row.scopesJson,
        row.tokenLabel,
        row.githubLogin,
        row.githubUserId,
        row.githubAvatarUrl,
        row.githubAccessToken,
        row.createdAtMs,
        row.expiresAtMs,
        row.lastSeenAtMs,
      );
  }

  get(sessionId: string): SessionRow | null {
    const row = this.db
      .prepare(`SELECT * FROM cache_sessions WHERE session_id = ?`)
      .get(sessionId) as unknown as DbSessionRow | undefined;
    return row ? rowFromDb(row) : null;
  }

  evict(sessionId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM cache_sessions WHERE session_id = ?`)
      .run(sessionId);
    return Number(result.changes ?? 0) > 0;
  }

  list(): SessionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cache_sessions ORDER BY last_seen_at DESC LIMIT 500`,
      )
      .all() as unknown as DbSessionRow[];
    return rows.map(rowFromDb);
  }

  cleanup(nowMs?: number): number {
    const cutoff = nowMs ?? Date.now();
    const result = this.db
      .prepare(`DELETE FROM cache_sessions WHERE expires_at <= ?`)
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

export function openSessionsStorage(dbPath: string): SessionsStorage {
  return new SqliteSessionsStorage(dbPath);
}
