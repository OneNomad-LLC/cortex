/**
 * In-memory background job registry.
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
 * Scope deliberately small for the first cut:
 *   - Map-backed, no persistence. Restart loses in-flight jobs.
 *     Persistent queue would need a schema migration; defer until the
 *     worker-fleet refactor (Pyre Business Plan doc 25, Phase 2).
 *   - Single-process FIFO queue. No fairness across tenants since
 *     one process == one tenant.
 *   - 24 h retention on completed/failed jobs so callers can fetch
 *     the result long after they kicked off the work.
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
}

const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum concurrent jobs running through `enqueue()` at once. Set to
 * 1 to match what a 2GB Pro Fly machine can comfortably do during
 * embedding-heavy ingest without OOM-ing. Override via the
 * CORTEX_MAX_CONCURRENT_JOBS env var when sizing changes (enterprise
 * Fly machines can handle 2-4).
 */
const MAX_CONCURRENT_DEFAULT = 1;

function resolveMaxConcurrent(): number {
  const raw = process.env.CORTEX_MAX_CONCURRENT_JOBS;
  if (!raw) return MAX_CONCURRENT_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_CONCURRENT_DEFAULT;
}

class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly waiting: Array<{ jobId: string; work: () => Promise<unknown> }> = [];
  private active = 0;
  private readonly maxConcurrent = resolveMaxConcurrent();

  create(opts: { kind: string }): JobRecord {
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
    };
    this.jobs.set(job.id, job);
    return job;
  }

  start(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.startedAtMs = Date.now();
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
  }

  complete(jobId: string, result: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "completed";
    job.finishedAtMs = Date.now();
    job.result = result;
  }

  fail(jobId: string, err: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.finishedAtMs = Date.now();
    job.error = err instanceof Error ? err.message : String(err);
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
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
  }

  /** Test-only: dump all jobs. Not part of the MCP surface. */
  _all(): readonly JobRecord[] {
    return Array.from(this.jobs.values());
  }

  /** Test-only: clear all jobs. */
  _reset(): void {
    this.jobs.clear();
  }
}

/**
 * Singleton — handlers + the kb_job_status tool both reach for it.
 * Scoping to a singleton matches the rest of cortex's process model
 * (one MCP server per workspace).
 */
export const jobs = new JobRegistry();
