import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCortexConfig } from "../config.js";
import { resolveConfigPath } from "./config-path.js";

const DEFAULT_PORT = 3030;

/**
 * `cortex dashboard` — spawns the Next.js dev server from the sibling
 * `@onenomad/cortex-dashboard` package. This is the local-per-user UI described in
 * ADR-015. The dashboard is a thin HTTP client that talks to the sidecar
 * API on `cortex start`, so the user should run both.
 *
 * Flags:
 *   --port <n>   Override dashboard port (default 3030)
 *   --build      Run `next build && next start` instead of dev.
 */
export async function runDashboard(args: string[]): Promise<number> {
  let port = DEFAULT_PORT;
  let build = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--port" || a === "-p") {
      const v = args[++i];
      if (!v || Number.isNaN(Number.parseInt(v, 10))) {
        process.stderr.write("cortex dashboard: --port needs a number\n");
        return 2;
      }
      port = Number.parseInt(v, 10);
    } else if (a.startsWith("--port=")) {
      port = Number.parseInt(a.slice("--port=".length), 10);
    } else if (a === "--build") {
      build = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else {
      process.stderr.write(`cortex dashboard: unknown arg '${a}'\n`);
      return 2;
    }
  }

  const dashboardDir = resolveDashboardDir();
  if (!dashboardDir) {
    process.stderr.write(
      "cortex dashboard: couldn't locate @onenomad/cortex-dashboard package. " +
        "Run this from a full cortex checkout.\n",
    );
    return 2;
  }

  // Read cortex.yaml to learn the sidecar port, so the dashboard rewrite
  // points at the right URL even when the operator has customized it.
  const apiUrl = await deriveApiUrl();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CORTEX_API_URL: apiUrl,
  };

  if (build) {
    const buildCode = await spawnNpx(dashboardDir, ["next", "build"], env);
    if (buildCode !== 0) return buildCode;
    return spawnNpx(
      dashboardDir,
      ["next", "start", "--port", String(port)],
      env,
    );
  }

  process.stdout.write(
    `Starting dashboard on http://localhost:${port} (API: ${apiUrl})\n`,
  );
  return spawnNpx(
    dashboardDir,
    ["next", "dev", "--port", String(port)],
    env,
  );
}

function resolveDashboardDir(): string | undefined {
  // Walk up from this file to the workspace root, then look for
  // packages/dashboard. Handles both source and installed layouts.
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

async function deriveApiUrl(): Promise<string> {
  const configPath = resolveConfigPath();
  try {
    const cfg = await loadCortexConfig(configPath);
    const host =
      cfg.api.host === "0.0.0.0" ? "127.0.0.1" : cfg.api.host;
    return `http://${host}:${cfg.api.port}`;
  } catch {
    return "http://127.0.0.1:4141";
  }
}

function spawnNpx(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    // `npx` on Windows lives behind a .cmd shim, so shell:true is the
    // simplest portable path — same pattern we use in tests.
    const child = spawn("npx", args, {
      cwd,
      env,
      stdio: "inherit",
      shell: true,
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`cortex dashboard: ${err.message}\n`);
      resolve(1);
    });
  });
}

const HELP = `cortex dashboard — launch the local web dashboard.

Usage:
  cortex dashboard [--port <n>] [--build]

Flags:
  --port <n>   Port for the dashboard (default 3030).
  --build      Production mode: next build then next start.

The dashboard is a thin HTTP client. It needs \`cortex start\` running
with \`api.enabled: true\` in cortex.yaml so the sidecar is reachable.
`;
