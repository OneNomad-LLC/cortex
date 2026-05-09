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
 * Scope deliberately small for the first cut:
 *   - Map-backed, no persistence. Restart loses in-flight jobs.
 *     Persistent queue would need a schema migration; defer until a
 *     real customer use case forces it.
 *   - Single-process. No worker pool — each job runs on the main
 *     event loop. Fine for I/O-heavy work (file walking, network
 *     fetches); a CPU-bound job would block.
 *   - 24 h retention on completed/failed jobs so callers can fetch
 *     the result long after they kicked off the work.
 *
 * Caller pattern:
 *   const job = jobs.create({ kind: 'ingest_repo' });
 *   void runWork()
 *     .then((result) => jobs.complete(job.id, result))
 *     .catch((err) => jobs.fail(job.id, err));
 *   return { jobId: job.id, queued: true };
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

class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();

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
