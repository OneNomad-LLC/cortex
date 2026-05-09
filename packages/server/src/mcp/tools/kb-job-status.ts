import { z } from "zod";
import type { McpTool } from "../tool.js";
import { jobs } from "../jobs.js";

const inputSchema = z.object({
  /** Job id returned by the originating async handler. */
  jobId: z.string().min(1),
});

interface Output {
  /** True when the registry knew the jobId. */
  found: boolean;
  jobId: string;
  /** queued / running / completed / failed; omitted when found=false. */
  status?: "queued" | "running" | "completed" | "failed";
  /** Free-form progress payload the handler updates mid-flight. Common
   *  shape: { totalUnits, doneUnits, message }. */
  progress?: Record<string, unknown>;
  /** Final payload on completed jobs (mirrors the synchronous return
   *  shape of the originating tool). */
  result?: unknown;
  /** Error message on failed jobs. */
  error?: string;
  /** ISO timestamps for the lifecycle. */
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/**
 * Poll an in-flight or recently-completed background job.
 *
 * The async-mode handlers (currently `ingest_repo` with `async: true`)
 * return `{ jobId, queued }` immediately and run the work in the
 * background; clients poll this to find out when the work finished
 * and what it produced. Completed / failed jobs are retained for 24
 * hours so a slow consumer can still fetch the result long after the
 * work landed.
 *
 * Unknown jobIds return `{ found: false }` rather than throwing —
 * lets pollers loop without special-casing the 'maybe expired'
 * branch.
 */
export const kbJobStatus: McpTool<typeof inputSchema, Output> = {
  name: "kb_job_status",
  description:
    "Check on a background job kicked off by an async-mode ingest tool " +
    "(e.g. ingest_repo with async: true). Returns { found, status, " +
    "progress, result } | { found: false } for expired/unknown ids. " +
    "Safe to poll every few seconds — purely in-memory lookup.",
  inputSchema,

  async handler(input) {
    const job = jobs.get(input.jobId);
    if (!job) {
      return { found: false, jobId: input.jobId };
    }
    return {
      found: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      ...(job.result !== null ? { result: job.result } : {}),
      ...(job.error !== null ? { error: job.error } : {}),
      createdAt: new Date(job.createdAtMs).toISOString(),
      startedAt: job.startedAtMs !== null ? new Date(job.startedAtMs).toISOString() : null,
      finishedAt: job.finishedAtMs !== null ? new Date(job.finishedAtMs).toISOString() : null,
    };
  },
};
