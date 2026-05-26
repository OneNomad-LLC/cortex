import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "./schema.js";
import type { JobRow, JobsListOptions, JobsStorage } from "./types.js";

interface DbJobRow {
  job_id: string;
  type: string;
  workspace: string;
  status: string;
  progress_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowFromDb(row: DbJobRow): JobRow {
  let progress: Record<string, unknown> | null = null;
  if (row.progress_json) {
    try {
      const parsed = JSON.parse(row.progress_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        progress = parsed as Record<string, unknown>;
      }
    } catch {
      // Poisoned JSON shouldn't bubble up — treat as no progress.
      progress = null;
    }
  }
  return {
    jobId: row.job_id,
    type: row.type,
    workspace: row.workspace,
    status: row.status as JobRow["status"],
    progress,
    error: row.error,
    createdAtMs: row.created_at,
    startedAtMs: row.started_at,
    finishedAtMs: row.finished_at,
  };
}

class SqliteJobsStorage implements JobsStorage {
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

  upsert(row: JobRow): void {
    const progressJson =
      row.progress && Object.keys(row.progress).length > 0
        ? JSON.stringify(row.progress)
        : null;
    this.db
      .prepare(
        `INSERT INTO cache_jobs
           (job_id, type, workspace, status, progress_json, error,
            created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET
           type           = excluded.type,
           workspace      = excluded.workspace,
           status         = excluded.status,
           progress_json  = excluded.progress_json,
           error          = excluded.error,
           started_at     = excluded.started_at,
           finished_at    = excluded.finished_at`,
      )
      .run(
        row.jobId,
        row.type,
        row.workspace,
        row.status,
        progressJson,
        row.error,
        row.createdAtMs,
        row.startedAtMs,
        row.finishedAtMs,
      );
  }

  get(jobId: string): JobRow | null {
    const row = this.db
      .prepare(`SELECT * FROM cache_jobs WHERE job_id = ?`)
      .get(jobId) as unknown as DbJobRow | undefined;
    return row ? rowFromDb(row) : null;
  }

  list(opts: JobsListOptions): JobRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (typeof opts.workspace === "string") {
      where.push("workspace = ?");
      params.push(opts.workspace);
    }
    if (typeof opts.sinceMs === "number") {
      where.push("created_at >= ?");
      params.push(opts.sinceMs);
    }
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM cache_jobs ${whereSql} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as DbJobRow[];
    return rows.map(rowFromDb);
  }

  cleanup(opts: { maxAgeMs: number; maxRows: number }): number {
    const now = Date.now();
    const cutoff = now - opts.maxAgeMs;
    // Age-based eviction — only purge terminal states. Active jobs
    // older than the window are a sign of trouble; surfacing them in
    // the UI beats silently dropping them.
    const aged = this.db
      .prepare(
        `DELETE FROM cache_jobs
         WHERE status IN ('completed', 'failed')
           AND finished_at IS NOT NULL
           AND finished_at < ?`,
      )
      .run(cutoff);
    let evicted = Number(aged.changes ?? 0);

    // Row-cap eviction — keep the most-recent maxRows by created_at.
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cache_jobs`)
      .get() as { n: number };
    const total = Number(countRow?.n ?? 0);
    if (total > opts.maxRows) {
      const overflow = total - opts.maxRows;
      const result = this.db
        .prepare(
          `DELETE FROM cache_jobs
           WHERE job_id IN (
             SELECT job_id FROM cache_jobs
             ORDER BY created_at ASC
             LIMIT ?
           )`,
        )
        .run(overflow);
      evicted += Number(result.changes ?? 0);
    }
    return evicted;
  }

  close(): void {
    this.db.close();
  }
}

export function openJobsStorage(dbPath: string): JobsStorage {
  return new SqliteJobsStorage(dbPath);
}
