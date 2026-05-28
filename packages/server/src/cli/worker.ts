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
 *   PRZM_CORTEX_WORKER_SECRET  — shared bearer for /api/cortex/jobs/* endpoints
 *   WORKER_ID             — opaque id, defaults to FLY_MACHINE_ID or hostname
 *
 * Optional env:
 *   PRZM_CORTEX_WORKER_POLL_MS — poll interval when queue is empty (default 5000)
 *   PRZM_CORTEX_WORKER_IDLE_EXIT_MS — exit after this many ms of empty polls
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
  const workerSecret = process.env.PRZM_CORTEX_WORKER_SECRET;
  if (!pyreWebUrl || !workerSecret) {
    throw new Error(
      "cortex worker: PYRE_WEB_URL and PRZM_CORTEX_WORKER_SECRET must both be set",
    );
  }
  const workerId =
    process.env.WORKER_ID ?? process.env.FLY_MACHINE_ID ?? `worker-${process.pid}`;
  const pollMs = Number.parseInt(process.env.PRZM_CORTEX_WORKER_POLL_MS ?? "5000", 10);
  const idleExitMs = Number.parseInt(
    process.env.PRZM_CORTEX_WORKER_IDLE_EXIT_MS ?? "60000",
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

const SUPPORTED_KINDS = new Set(["ingest_repo", "ingest_url", "ingest_file"]);

/**
 * Execute a claimed job by calling back into the tenant's Cortex MCP
 * over HTTP. The tenant's MCP server has the workspace context + the
 * pgvector store mounted; the worker just orchestrates.
 *
 * Why not run the ingest pipeline locally in the worker process? The
 * embedding + pgvector write paths are bound to a workspace-scoped
 * storage adapter the MCP server constructs at boot. Re-creating that
 * adapter per-job in worker code is doable but requires lifting a
 * lot of singleton state — out of scope for v1. The worker's value
 * here is queue isolation: jobs survive MCP server restarts (the
 * queue is in pyre-web's Postgres) and ingest doesn't tie up the
 * per-tenant transport.
 *
 * The HTTP call uses the existing /api/mcp/tools/:name/invoke
 * endpoint, which is already gateway-secret-authed and runs the tool
 * inline against the workspace. Forces `async: false` in the input
 * to prevent recursive queueing.
 */
async function execute(claimed: ClaimedJob): Promise<unknown> {
  const { kind, payload } = claimed.job;
  if (!SUPPORTED_KINDS.has(kind)) {
    throw new Error(`unsupported job kind: ${kind}`);
  }
  const { gatewaySecret, flyHostname, hostname } = claimed.deployment;
  if (!gatewaySecret) {
    throw new Error(
      "tenant deployment has no gateway secret — worker cannot authenticate back to it",
    );
  }
  // Prefer the .fly.dev hostname for worker → tenant calls. The pretty
  // hostname's Let's Encrypt cert can be in-flight after a fresh
  // deploy; .fly.dev is always serving.
  const host = flyHostname ?? hostname;
  if (!host) {
    throw new Error("tenant deployment has neither flyHostname nor hostname");
  }
  const url = `https://${host}:4141/api/mcp/tools/${encodeURIComponent(kind)}/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cortex-gateway-secret": gatewaySecret,
    },
    body: JSON.stringify({
      input: { ...payload, async: false },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`tenant invoke failed (${res.status}): ${text || res.statusText}`);
  }
  return await res.json();
}

export async function runWorker(): Promise<number> {
  // Air-gap guard: the worker's only function is polling pyre-web for jobs
  // and reporting results back. In telemetry-disabled mode (air-gap deployments)
  // this outbound traffic is not allowed — the operator's network policy will
  // block it anyway, but we fail fast with a clear diagnostic rather than
  // hanging on unreachable connections.
  if (process.env["PRZM_CORTEX_TELEMETRY"] === "disabled") {
    process.stderr.write(
      "cortex worker: PRZM_CORTEX_TELEMETRY=disabled — worker is not permitted in air-gap mode.\n" +
        "  The worker polls pyre-web for jobs, which requires outbound network access.\n" +
        "  In air-gap deployments, trigger ingest directly via MCP tools (ingest_repo, ingest_url).\n",
    );
    return 1;
  }

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
