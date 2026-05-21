/**
 * In-memory JobsStorage for unit tests. The real SQLite implementation
 * imports `node:sqlite`, which vitest's transform pipeline can't
 * resolve as a runtime module — so route tests inject this fake
 * instead. The contract matches the SQLite version so JobRegistry's
 * behavior under persistence is exercised end to end.
 *
 * Real persistence is covered by `packages/cache-sqlite/tests/jobs.test.mjs`
 * (run under `node --test`, which doesn't have the vite-resolve issue).
 */

import type {
  JobRow,
  JobsListOptions,
  JobsStorage,
} from "@onenomad/przm-cortex-cache-sqlite";

export function makeInMemoryJobsStorage(): JobsStorage {
  const rows = new Map<string, JobRow>();
  return {
    upsert(row) {
      rows.set(row.jobId, { ...row, progress: row.progress ? { ...row.progress } : null });
    },
    get(jobId) {
      const row = rows.get(jobId);
      return row ? { ...row, progress: row.progress ? { ...row.progress } : null } : null;
    },
    list(opts: JobsListOptions) {
      let out = Array.from(rows.values());
      if (opts.status) out = out.filter((r) => r.status === opts.status);
      if (typeof opts.workspace === "string") {
        out = out.filter((r) => r.workspace === opts.workspace);
      }
      if (typeof opts.sinceMs === "number") {
        out = out.filter((r) => r.createdAtMs >= opts.sinceMs!);
      }
      out.sort((a, b) => b.createdAtMs - a.createdAtMs);
      const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
      return out.slice(0, limit).map((r) => ({
        ...r,
        progress: r.progress ? { ...r.progress } : null,
      }));
    },
    cleanup(opts) {
      const cutoff = Date.now() - opts.maxAgeMs;
      let evicted = 0;
      for (const [id, row] of rows) {
        if (
          (row.status === "completed" || row.status === "failed") &&
          row.finishedAtMs !== null &&
          row.finishedAtMs < cutoff
        ) {
          rows.delete(id);
          evicted++;
        }
      }
      if (rows.size > opts.maxRows) {
        const overflow = rows.size - opts.maxRows;
        const ordered = Array.from(rows.values()).sort(
          (a, b) => a.createdAtMs - b.createdAtMs,
        );
        for (let i = 0; i < overflow; i++) {
          rows.delete(ordered[i]!.jobId);
          evicted++;
        }
      }
      return evicted;
    },
    close() {
      rows.clear();
    },
  };
}
