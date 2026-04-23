import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Spawn a cross-platform detached child that survives the parent's
 * exit. stdout/stderr are redirected to log files under
 * `~/.cortex/logs/<session>/` so the user can tail them later. The
 * child is unref'd immediately so Node's event loop doesn't keep the
 * parent alive on its account.
 *
 * Return value carries the child's PID and its log paths so the
 * caller can print them to the user.
 */
export interface DetachedSpawn {
  pid: number;
  stdoutLog: string;
  stderrLog: string;
}

export interface DetachedOptions {
  command: string;
  args: readonly string[];
  /** Working directory. Default: parent's cwd. */
  cwd?: string;
  /** Extra env merged on top of process.env. */
  env?: Record<string, string>;
  /** Logical session directory (shared between co-spawned children). */
  sessionDir: string;
  /** Friendly name for log filenames — e.g. "sidecar", "dashboard". */
  label: string;
}

/**
 * Where per-session logs land. One dir per `cortex init` invocation
 * keeps the sidecar + dashboard logs side by side for easy pairing.
 */
export function sessionLogDir(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return path.join(os.homedir(), ".cortex", "logs", `setup-${stamp}`);
}

export async function spawnDetached(
  opts: DetachedOptions,
): Promise<DetachedSpawn> {
  await mkdir(opts.sessionDir, { recursive: true });
  const stdoutLog = path.join(opts.sessionDir, `${opts.label}.stdout.log`);
  const stderrLog = path.join(opts.sessionDir, `${opts.label}.stderr.log`);

  const outHandle = await open(stdoutLog, "a");
  const errHandle = await open(stderrLog, "a");

  // The stdio triplet is: [inherit stdin as /dev/null, pipe stdout to
  // file, pipe stderr to file]. Using "ignore" for stdin matters on
  // Windows — the child shouldn't inherit the parent's console handle
  // because that's what keeps it alive when the parent closes.
  const child: ChildProcess = spawn(opts.command, [...opts.args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    detached: true,
    stdio: ["ignore", outHandle.fd, errHandle.fd],
    // On Windows, `shell: true` lets us resolve .cmd/.bat shims (npm,
    // pnpm, etc.) without knowing the exact extension. Unix ignores it.
    shell: process.platform === "win32",
    windowsHide: true,
  });

  // Unref so the parent Node process exits even with the child still
  // running. The child's own event loop keeps it alive.
  child.unref();

  // Close our copy of the file handles — the child inherited its own
  // via stdio. Not awaiting because the child has its own reference.
  outHandle.close().catch(() => undefined);
  errHandle.close().catch(() => undefined);

  if (!child.pid) {
    throw new Error(
      `spawnDetached: ${opts.command} failed to start (no pid). ` +
        `Check ${stderrLog} for details.`,
    );
  }

  return {
    pid: child.pid,
    stdoutLog,
    stderrLog,
  };
}

/**
 * Poll an HTTP URL until it responds 2xx or the timeout elapses.
 * Used after spawning the dashboard sidecar so we don't open the
 * browser before the server is ready to serve the setup page.
 */
export async function waitForHttp(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeout = opts.timeoutMs ?? 20_000;
  const interval = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(interval) });
      if (res.ok) return true;
    } catch {
      // Not reachable yet — sleep and retry.
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/**
 * Open a URL in the user's default browser. Fire-and-forget — if the
 * OS helper fails, the caller can still print the URL so the user
 * can click or copy.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const [cmd, args] = browserCommand(url);
  if (!cmd) return false;
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function browserCommand(url: string): [string | undefined, string[]] {
  switch (process.platform) {
    case "win32":
      // `start` is a cmd builtin. Empty quoted string is the "title"
      // positional that `start` eats before the URL.
      return ["cmd", ["/c", "start", '""', url]];
    case "darwin":
      return ["open", [url]];
    default:
      return ["xdg-open", [url]];
  }
}
