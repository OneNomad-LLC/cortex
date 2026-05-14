/**
 * Cortex worker entrypoint. Long-running process that polls pyre-web
 * for queued jobs, claims one at a time, executes the ingest pipeline,
 * and reports results back.
 *
 * Architecture: see Pyre Business Plan doc 25 (Cortex Production
 * Readiness). The worker is a peer to the per-tenant MCP server —
 * same Docker image, different entrypoint. Deployed as a separate
 * Fly app (`cortex-workers`) with autoscale-to-zero.
 *
 * Required env:
 *   PYRE_WEB_URL          — e.g. https://pyre.sh or https://dev.pyre.sh
 *   CORTEX_WORKER_SECRET  — shared bearer for /api/cortex/jobs/* endpoints
 *   WORKER_ID             — opaque id, defaults to FLY_MACHINE_ID or hostname
 *
 * Optional env:
 *   CORTEX_WORKER_POLL_MS — poll interval when queue is empty (default 5000)
 *   CORTEX_WORKER_IDLE_EXIT_MS — exit after this many ms of empty polls
 *                                 so Fly auto_stop_machines can park us
 *                                 (default 60000; 0 disables idle exit)
 */

interface WorkerConfig {
  pyreWebUrl: string;
  workerSecret: string;
  workerId: string;
  pollMs: number;
  idleExitMs: number;
}

interface ClaimedJob {
  job: {
    id: string;
    tenantId: number;
    deploymentId: number | null;
    kind: string;
    payload: Record<string, unknown>;
  };
  deployment: {
    gatewaySecret: string | null;
    flyHostname: string | null;
    hostname: string | null;
  };
}

function readConfig(): WorkerConfig {
  const pyreWebUrl = process.env.PYRE_WEB_URL?.replace(/\/+$/, "");
  const workerSecret = process.env.CORTEX_WORKER_SECRET;
  if (!pyreWebUrl || !workerSecret) {
    throw new Error(
      "cortex worker: PYRE_WEB_URL and CORTEX_WORKER_SECRET must both be set",
    );
  }
  const workerId =
    process.env.WORKER_ID ?? process.env.FLY_MACHINE_ID ?? `worker-${process.pid}`;
  const pollMs = Number.parseInt(process.env.CORTEX_WORKER_POLL_MS ?? "5000", 10);
  const idleExitMs = Number.parseInt(
    process.env.CORTEX_WORKER_IDLE_EXIT_MS ?? "60000",
    10,
  );
  return { pyreWebUrl, workerSecret, workerId, pollMs, idleExitMs };
}

async function claim(cfg: WorkerConfig): Promise<ClaimedJob | null> {
  const res = await fetch(`${cfg.pyreWebUrl}/api/cortex/jobs/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.workerSecret}`,
      "x-cortex-worker-id": cfg.workerId,
    },
    body: JSON.stringify({}),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`claim failed (${res.status}): ${text || res.statusText}`);
  }
  return (await res.json()) as ClaimedJob;
}

async function reportComplete(
  cfg: WorkerConfig,
  jobId: string,
  result: unknown,
): Promise<void> {
  const res = await fetch(`${cfg.pyreWebUrl}/api/cortex/jobs/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.workerSecret}`,
      "x-cortex-worker-id": cfg.workerId,
    },
    body: JSON.stringify({ jobId, status: "completed", result }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`complete failed (${res.status}): ${text || res.statusText}`);
  }
}

async function reportFailed(
  cfg: WorkerConfig,
  jobId: string,
  error: string,
): Promise<void> {
  const res = await fetch(`${cfg.pyreWebUrl}/api/cortex/jobs/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.workerSecret}`,
      "x-cortex-worker-id": cfg.workerId,
    },
    body: JSON.stringify({ jobId, status: "failed", error }),
  }).catch(() => null);
  if (res && !res.ok) {
    const text = await res.text().catch(() => "");
    process.stderr.write(
      `cortex worker: report-failed call failed (${res.status}): ${text || res.statusText}\n`,
    );
  }
}

/**
 * Dispatch a claimed job to the right runner.
 *
 * NOTE (P2.3 follow-up): the runners need a tenant-scoped storage
 * adapter to write results into the right pgvector store. Today
 * runIngestRepo / runIngestUrl pull from a singleton ctx
 * established at MCP server boot, which doesn't exist in worker
 * context. Wiring a tenant-scoped storage client per-job is the
 * remaining work. For now this worker can claim + report-back the
 * plumbing, and the actual ingest execution still happens on the
 * per-tenant MCP machine via the legacy in-process job runner.
 *
 * To exercise the queue plumbing without the storage wiring,
 * workers report jobs as failed with a clear reason — the MCP
 * server stays the source-of-truth for ingest execution until the
 * storage refactor lands.
 */
async function execute(claimed: ClaimedJob): Promise<unknown> {
  const { kind } = claimed.job;
  if (kind === "ingest_repo" || kind === "ingest_url" || kind === "ingest_file") {
    throw new Error(
      "P2.3 not yet implemented: worker-side execution requires tenant-scoped storage adapter wiring (the runIngest* functions live in the MCP server's bound context, not callable standalone yet). Until that lands, the per-tenant MCP server's in-process runner handles the work and this worker only exercises the queue + report-back plumbing.",
    );
  }
  throw new Error(`unsupported job kind: ${kind}`);
}

export async function runWorker(): Promise<number> {
  const cfg = readConfig();
  process.stdout.write(
    `cortex worker: starting (id=${cfg.workerId}) — polling ${cfg.pyreWebUrl} every ${cfg.pollMs}ms\n`,
  );

  let idleSince = Date.now();
  let stopping = false;
  const onSignal = () => {
    process.stdout.write("cortex worker: received shutdown signal, exiting\n");
    stopping = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  while (!stopping) {
    let claimed: ClaimedJob | null = null;
    try {
      claimed = await claim(cfg);
    } catch (err) {
      process.stderr.write(
        `cortex worker: claim error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    if (!claimed) {
      if (cfg.idleExitMs > 0 && Date.now() - idleSince > cfg.idleExitMs) {
        process.stdout.write(
          `cortex worker: idle for ${cfg.idleExitMs}ms, exiting (Fly will park me)\n`,
        );
        return 0;
      }
      await new Promise((r) => setTimeout(r, cfg.pollMs));
      continue;
    }

    idleSince = Date.now();
    process.stdout.write(
      `cortex worker: claimed job ${claimed.job.id} (kind=${claimed.job.kind}, tenant=${claimed.job.tenantId})\n`,
    );

    try {
      const result = await execute(claimed);
      await reportComplete(cfg, claimed.job.id, result);
      process.stdout.write(`cortex worker: completed ${claimed.job.id}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `cortex worker: job ${claimed.job.id} failed: ${message}\n`,
      );
      await reportFailed(cfg, claimed.job.id, message);
    }
  }

  return 0;
}
