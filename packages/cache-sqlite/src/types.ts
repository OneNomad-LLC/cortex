export interface CacheReadResult {
  payload: unknown;
  refreshedAt: string;
  failureCount: number;
  lastError: string | null;
}

export interface CacheStorage {
  read(
    widgetName: string,
    workspace: string,
    cacheKey: string,
  ): CacheReadResult | null;

  write(
    widgetName: string,
    workspace: string,
    cacheKey: string,
    payload: unknown,
    refreshedAt: string,
  ): void;

  recordFailure(
    widgetName: string,
    workspace: string,
    cacheKey: string,
    error: string,
  ): void;

  close(): void;
}

/**
 * Persistent shadow of the in-memory JobRegistry. The Cortex server's
 * job registry is the source of truth while a process is alive — this
 * storage mirrors every status transition so a restart (Fly machine
 * recycle, dev iteration) doesn't strand in-flight or recently-finished
 * jobs. Reads from the dashboard's `/api/dashboard/jobs` surface fall
 * back to this when the in-memory map doesn't have the id.
 */
export interface JobRow {
  jobId: string;
  /** Tool name that created the job (ingest_repo, ingest_url, ingest_url:crawl, ...). */
  type: string;
  /** Workspace slug, or empty string for an unbound session. */
  workspace: string;
  status: "queued" | "running" | "completed" | "failed";
  /** Free-form per-handler progress patch. `null` until the handler writes one. */
  progress: Record<string, unknown> | null;
  /** Error message on failed jobs. Empty / null otherwise. */
  error: string | null;
  /** Epoch ms — when the registry first saw the job. */
  createdAtMs: number;
  /** Epoch ms — when status flipped to "running". Null while queued. */
  startedAtMs: number | null;
  /** Epoch ms — when status flipped to terminal. Null while in-flight. */
  finishedAtMs: number | null;
}

export interface JobsListOptions {
  /** Filter by status. Omit to include every state. */
  status?: JobRow["status"];
  /** Workspace slug filter; omit to include every workspace. */
  workspace?: string;
  /**
   * Only return jobs newer than this epoch ms. Used by the "recent"
   * Dashboard view (default 24h window).
   */
  sinceMs?: number;
  /** Hard cap. Default 100 in callers — storage layer is agnostic. */
  limit?: number;
}

export interface JobsStorage {
  /** Insert-or-replace a single job row. Called on every status transition. */
  upsert(row: JobRow): void;
  /** Lookup by id. Returns null on miss. */
  get(jobId: string): JobRow | null;
  /** Filtered listing. Always sorted newest-first by createdAt. */
  list(opts: JobsListOptions): JobRow[];
  /**
   * Trim the table:
   *   - Drop completed/failed rows older than `maxAgeMs`.
   *   - If total rows exceed `maxRows`, drop the oldest until the cap holds.
   *
   * Returns the number of rows evicted.
   */
  cleanup(opts: { maxAgeMs: number; maxRows: number }): number;
  close(): void;
}
