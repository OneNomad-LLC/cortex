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

/**
 * Persistent shadow of dashboard browser sessions. The server's in-memory
 * sessionStates map is the live source of truth; this storage mirrors
 * every dashboard-authenticated session so a process restart doesn't
 * kick the operator back to the login screen. The dashboard sign-in path
 * (raw token paste OR GitHub Device Flow) writes through; subsequent
 * cookie hits read from in-memory first, falling back to storage on a
 * cold-cache miss.
 *
 * Only sessions with `dashboardScopes` get persisted — plain MCP
 * sessions stay in-memory only.
 */
export interface SessionRow {
  /** `dash_<uuid>` cookie value. */
  sessionId: string;
  /** Workspace slug — `""` represents an unbound session. */
  workspace: string;
  /** JSON-encoded array of scopes (admin / read / ingest). */
  scopesJson: string;
  /** Normalized label for token-paste auth; null when authenticated via GitHub OAuth. */
  tokenLabel: string | null;
  /** GitHub username when OAuth-authenticated; null otherwise. */
  githubLogin: string | null;
  /** Stable numeric GitHub user id (defends against rename collisions). */
  githubUserId: number | null;
  /** Avatar URL for whoami rendering. */
  githubAvatarUrl: string | null;
  /** Raw GitHub access token. Read by Slice B to call the GitHub API on the user's behalf. */
  githubAccessToken: string | null;
  /** Epoch ms — when the session was first minted. */
  createdAtMs: number;
  /** Epoch ms — when the session should be evicted (default mint+24h). */
  expiresAtMs: number;
  /** Epoch ms — bumps on every cookie hit so sliding-window TTL is possible later. */
  lastSeenAtMs: number;
}

export interface SessionsStorage {
  /** Insert-or-replace a single session row. Called on sign-in + cookie touch. */
  upsert(row: SessionRow): void;
  /** Lookup by session id. Returns null on miss. */
  get(sessionId: string): SessionRow | null;
  /** Drop a session row. Returns true if the row existed. */
  evict(sessionId: string): boolean;
  /** Snapshot listing — used by tests + the future "/api/dashboard/sessions" surface. */
  list(): SessionRow[];
  /**
   * Drop every row whose `expires_at <= now`. Returns the count
   * evicted. Cheap enough to run on every session-GC tick.
   */
  cleanup(nowMs?: number): number;
  close(): void;
}
