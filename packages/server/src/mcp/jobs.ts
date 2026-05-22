/**
 * Background job registry — in-memory hot path, SQLite-backed shadow.
 *
 * Some ingest paths are slow — `ingest_repo` against a 2000-file tree
 * can take a minute; `ingest_url` with a deep crawl can take longer.
 * Synchronous handlers tie up the MCP transport for that whole time
 * and surface to the caller as 'is it stuck?' silence. The job
 * registry lets a handler return `{ jobId, queued: true }` immediately
 * and run the actual work in the background; callers poll
 * `kb_job_status({ jobId })` for progress.
 *
 * Concurrency control: jobs submitted via `enqueue()` respect a
 * process-wide cap (MAX_CONCURRENT). Excess jobs sit in the registry
 * with status='queued' until a slot opens. Cortex runs single-tenant
 * per Fly machine so a process-wide cap IS the per-tenant cap. Without
 * this, two parallel ingest_repo calls OOM the box (reproduced today
 * during the first cortex codebase ingest experiment).
 *
 * Persistence: every status transition is mirrored to a SQLite
 * `cache_jobs` table via `@onenomad/przm-cortex-cache-sqlite`. The
 * in-memory map remains the hot read path; restarting the process or
 * a stale-poll race that lands on a process the registry hasn't seen
 * yet falls back to the persistent store. Without this a Fly machine
 * recycle (or any dev iteration) stranded the Dashboard's Jobs view
 * with empty 'Recent' lists.
 *
 * Caller pattern (preferred — concurrency-aware):
 *   const job = jobs.create({ kind: 'ingest_repo' });
 *   jobs.enqueue(job.id, () => runWork());
 *   return { jobId: job.id, queued: true };
 *
 * Legacy pattern (still supported, ignores concurrency cap):
 *   const job = jobs.create({ kind: 'ingest_repo' });
 *   void runWork()
 *     .then((result) => jobs.complete(job.id, result))
 *     .catch((err) => jobs.fail(job.id, err));
 */

import { randomUUID } from "node:crypto";
import type {
  JobRow,
  JobsListOptions,
  JobsStorage,
} from "@onenomad/przm-cortex-cache-sqlite";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobRecord {
  id: string;
  /** Tool name that created the job (ingest_repo, ingest_url, etc.). */
  kind: string;
  status: JobStatus;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  /**
   * Free-form progress payload the handler can update mid-flight.
   * Convention: `{ totalUnits?: number, doneUnits?: number, message?: string }`
   * but the registry doesn't enforce shape — clients render what's
   * present and skip what isn't.
   */
  progress: Record<string, unknown>;
  /** Final result on completed jobs. Mirrors the synchronous return. */
  result: unknown | null;
  /** Error message on failed jobs. */
  error: string | null;
  /**
   * Workspace slug this job was created in. Empty string when the
   * session was in no-workspace mode. The persistent shadow surfaces
   * this so the Dashboard Jobs page can scope listings per workspace.
   */
  workspace: string;
}

const RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * Persistent shadow retention. Keeps the last week of finished jobs +
 * any in-flight rows, capped at 1000 total. Pyre's Dashboard "Recent"
 * list reads from this, so the cap balances "enough to scroll history"
 * against "don't grow the on-disk file unbounded".
 */
const PERSISTENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PERSISTENT_MAX_ROWS = 1000;

/**
 * Maximum concurrent jobs running through `enqueue()` at once. Set to
 * 1 to match what a 2GB Pro Fly machine can comfortably do during
 * embedding-heavy ingest without OOM-ing. Override via the
 * PRZM_CORTEX_MAX_CONCURRENT_JOBS env var when sizing changes (enterprise
 * Fly machines can handle 2-4).
 */
const MAX_CONCURRENT_DEFAULT = 1;

function resolveMaxConcurrent(): number {
  const raw = process.env.PRZM_CORTEX_MAX_CONCURRENT_JOBS;
  if (!raw) return MAX_CONCURRENT_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_CONCURRENT_DEFAULT;
}

class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly waiting: Array<{ jobId: string; work: () => Promise<unknown> }> = [];
  private active = 0;
  private readonly maxConcurrent = resolveMaxConcurrent();
  private storage: JobsStorage | null = null;
  /** Default workspace stamped on jobs when create() isn't passed one. */
  private defaultWorkspace = "";

  /**
   * Wire a persistent shadow. Called once at server boot after the
   * SQLite cache opens — tests skip this so they exercise the
   * in-memory path alone.
   */
  setStorage(storage: JobsStorage | null): void {
    this.storage = storage;
    if (storage) {
      storage.cleanup({
        maxAgeMs: PERSISTENT_MAX_AGE_MS,
        maxRows: PERSISTENT_MAX_ROWS,
      });
    }
  }

  /**
   * Set the workspace slug auto-stamped on every job created without
   * an explicit `workspace`. Boot-time wiring uses this so the
   * dashboard's per-workspace listing works without every caller
   * having to thread the slug through.
   */
  setDefaultWorkspace(slug: string): void {
    this.defaultWorkspace = slug;
  }

  create(opts: { kind: string; workspace?: string }): JobRecord {
    this.gc();
    const now = Date.now();
    const job: JobRecord = {
      id: randomUUID(),
      kind: opts.kind,
      status: "queued",
      createdAtMs: now,
      startedAtMs: null,
      finishedAtMs: null,
      progress: {},
      result: null,
      error: null,
      workspace: opts.workspace ?? this.defaultWorkspace,
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    return job;
  }

  start(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.startedAtMs = Date.now();
    this.persist(job);
  }

  /**
   * Submit a job to the concurrency-capped runner. Use this instead of
   * calling work() directly — it respects MAX_CONCURRENT_JOBS so the
   * process doesn't OOM under parallel submission. Jobs over the cap
   * sit at status='queued' until a slot opens; the registry transitions
   * them to 'running' when the worker actually starts the work.
   */
  enqueue(jobId: string, work: () => Promise<unknown>): void {
    if (!this.jobs.has(jobId)) return;
    if (this.active < this.maxConcurrent) {
      this.runOne(jobId, work);
    } else {
      this.waiting.push({ jobId, work });
    }
  }

  /**
   * How many slots are currently busy / waiting. Useful for the
   * dashboard / kb_job_status surface; not part of the MCP tool API.
   */
  utilization(): { active: number; waiting: number; max: number } {
    return { active: this.active, waiting: this.waiting.length, max: this.maxConcurrent };
  }

  private runOne(jobId: string, work: () => Promise<unknown>): void {
    this.active += 1;
    this.start(jobId);
    void work()
      .then((result) => this.complete(jobId, result))
      .catch((err) => this.fail(jobId, err))
      .finally(() => {
        this.active -= 1;
        const next = this.waiting.shift();
        if (next) this.runOne(next.jobId, next.work);
      });
  }

  progress(jobId: string, patch: Record<string, unknown>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    Object.assign(job.progress, patch);
    this.persist(job);
  }

  complete(jobId: string, result: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "completed";
    job.finishedAtMs = Date.now();
    job.result = result;
    this.persist(job);
  }

  fail(jobId: string, err: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.finishedAtMs = Date.now();
    job.error = err instanceof Error ? err.message : String(err);
    this.persist(job);
  }

  get(jobId: string): JobRecord | undefined {
    const hit = this.jobs.get(jobId);
    if (hit) return hit;
    // Miss in-memory — fall back to the persistent shadow so kb_job_status
    // polls survive a process restart. Hydrated rows lose `result` (it
    // isn't serialized) but keep status / progress / error which is what
    // the poller actually renders.
    if (!this.storage) return undefined;
    const row = this.storage.get(jobId);
    if (!row) return undefined;
    return rowToRecord(row);
  }

  /**
   * Listing surface used by the Dashboard. Reads the persistent store
   * directly so both in-flight and historical rows show up; the
   * in-memory map is a write-through cache so it has nothing the
   * shadow doesn't already carry.
   */
  list(opts: JobsListOptions = {}): JobRecord[] {
    if (this.storage) {
      return this.storage.list(opts).map(rowToRecord);
    }
    // No persistent shadow (tests) — fall back to the in-memory map.
    const all = Array.from(this.jobs.values());
    let filtered = all;
    if (opts.status) filtered = filtered.filter((j) => j.status === opts.status);
    if (typeof opts.workspace === "string") {
      filtered = filtered.filter((j) => j.workspace === opts.workspace);
    }
    if (typeof opts.sinceMs === "number") {
      filtered = filtered.filter((j) => j.createdAtMs >= opts.sinceMs!);
    }
    filtered.sort((a, b) => b.createdAtMs - a.createdAtMs);
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    return filtered.slice(0, limit);
  }

  private persist(job: JobRecord): void {
    if (!this.storage) return;
    const row: JobRow = {
      jobId: job.id,
      type: job.kind,
      workspace: job.workspace,
      status: job.status,
      progress: Object.keys(job.progress).length > 0 ? job.progress : null,
      error: job.error,
      createdAtMs: job.createdAtMs,
      startedAtMs: job.startedAtMs,
      finishedAtMs: job.finishedAtMs,
    };
    try {
      this.storage.upsert(row);
    } catch {
      // SQLite write failures must not crash the job lifecycle —
      // the in-memory record stays authoritative for the live process.
      // Tests for the storage layer cover schema/upsert correctness.
    }
  }

  /**
   * Drop completed / failed jobs older than RETENTION_MS. Called
   * lazily on every create() — no separate timer to leak.
   */
  private gc(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, job] of this.jobs) {
      const finished = job.finishedAtMs ?? 0;
      if (
        (job.status === "completed" || job.status === "failed") &&
        finished > 0 &&
        finished < cutoff
      ) {
        this.jobs.delete(id);
      }
    }
    if (this.storage) {
      try {
        this.storage.cleanup({
          maxAgeMs: PERSISTENT_MAX_AGE_MS,
          maxRows: PERSISTENT_MAX_ROWS,
        });
      } catch {
        // Cleanup failure is non-fatal; the next gc() retries.
      }
    }
  }

  /** Test-only: dump all jobs. Not part of the MCP surface. */
  _all(): readonly JobRecord[] {
    return Array.from(this.jobs.values());
  }

  /** Test-only: clear all jobs (in-memory only — storage cleared via wipe). */
  _reset(): void {
    this.jobs.clear();
    this.waiting.length = 0;
    this.active = 0;
    this.storage = null;
    this.defaultWorkspace = "";
  }
}

function rowToRecord(row: JobRow): JobRecord {
  return {
    id: row.jobId,
    kind: row.type,
    status: row.status,
    createdAtMs: row.createdAtMs,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs,
    progress: row.progress ?? {},
    // Persisted shadow doesn't carry result payloads — they can be
    // large (full ingest output) and aren't read by any current
    // consumer. Hydrated record returns null; live polls go through
    // the in-memory map which DOES keep it.
    result: null,
    error: row.error,
    workspace: row.workspace,
  };
}

/**
 * Singleton — handlers + the kb_job_status tool both reach for it.
 * Scoping to a singleton matches the rest of cortex's process model
 * (one MCP server per workspace).
 */
export const jobs = new JobRegistry();
