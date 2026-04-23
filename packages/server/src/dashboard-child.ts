import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "@onenomad/cortex-core";

/**
 * Auto-start the Next.js dashboard as a child of `cortex start` when
 * the HTTP sidecar is enabled. Keeps the "one process, one command"
 * UX — users don't need `cortex dashboard` in a separate terminal.
 *
 * Only starts when CORTEX_MCP_TRANSPORT is http, because in stdio
 * mode Cortex is being run as a Claude Code subprocess and spawning
 * Next.js inside that process tree would be intrusive (and noisy).
 */
export interface DashboardChildHandle {
  pid?: number;
  stop(): Promise<void>;
}

export interface StartDashboardChildOptions {
  logger: Logger;
  port?: number;
  apiPort: number;
  apiHost: string;
}

export async function startDashboardChild(
  opts: StartDashboardChildOptions,
): Promise<DashboardChildHandle | undefined> {
  const dashboardDir = resolveDashboardDir();
  if (!dashboardDir) {
    opts.logger.warn("dashboard.skip", {
      reason: "couldn't locate @onenomad/cortex-dashboard package dir",
    });
    return undefined;
  }

  const port = opts.port ?? 3030;
  const apiUrl = `http://${opts.apiHost === "0.0.0.0" ? "127.0.0.1" : opts.apiHost}:${opts.apiPort}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CORTEX_API_URL: apiUrl,
  };

  // `stdio: "pipe"` so the daemon's own log stream captures Next's
  // output and tags it. stdio: "inherit" would interleave raw with
  // cortex's JSON logs and confuse anyone tailing.
  const child: ChildProcess = spawn(
    "npx",
    ["next", "dev", "--port", String(port)],
    {
      cwd: dashboardDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) opts.logger.info("dashboard.stdout", { line });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) opts.logger.warn("dashboard.stderr", { line });
    }
  });
  child.on("exit", (code, signal) => {
    opts.logger.info("dashboard.exit", {
      code: code ?? undefined,
      signal: signal ?? undefined,
    });
  });

  opts.logger.info("dashboard.started", {
    pid: child.pid,
    dir: dashboardDir,
    port,
    apiUrl,
  });

  return {
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    async stop() {
      if (!child.pid || child.exitCode !== null) return;
      child.kill("SIGTERM");
      // Give Next a moment to tear down; force-kill if it overstays.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * Walk up from this file to find the @onenomad/cortex-dashboard package.
 * Mirrors the resolver in cli/dashboard.ts so both paths share the
 * same discovery logic; kept inline here to avoid a circular import.
 */
function resolveDashboardDir(): string | undefined {
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "packages", "dashboard");
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
