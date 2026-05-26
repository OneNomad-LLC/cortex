import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./dotenv.js";

/**
 * `cortex update` — pull the latest image and restart the cortex
 * service in place. Designed for VPS / DO upgrades where the operator
 * wants "one command, no rebuild, workspace state preserved".
 *
 * Default flow (pull mode):
 *   1. `docker compose pull cortex`        ← grab the new image from
 *                                            whatever registry the
 *                                            compose file points at
 *   2. `docker compose up -d --no-deps cortex` ← recreate just the
 *                                            cortex container; leaves
 *                                            postgres / ollama / etc.
 *                                            alone if they're running
 *   3. `docker compose ps cortex` + a few log lines so the operator
 *      sees the new image came up cleanly
 *
 * Build mode (`--build`): for environments without a pre-built image
 * in a registry. Runs `git pull --ff-only` (if invoked from inside the
 * git tree) then `docker compose build cortex` and the same
 * recreate. Slower — 2-5 min on a small droplet — but no registry
 * needed.
 *
 * Workspace state (PRZM_CORTEX_HOME_HOST) is bind-mounted and never
 * touched by this command. The container is recreated but the volume
 * survives. Restart downtime is ~5s on pull mode, longer on build
 * because the image rebuild blocks restart.
 */

function locateComposeFile(): string | undefined {
  const start = findRepoRoot(process.cwd());
  const candidate = path.join(start, "docker-compose.yml");
  if (existsSync(candidate)) return candidate;
  return undefined;
}

function isInsideGitRepo(dir: string): boolean {
  let cur = dir;
  while (cur !== path.dirname(cur)) {
    if (existsSync(path.join(cur, ".git"))) return true;
    cur = path.dirname(cur);
  }
  return false;
}

function composeImageFromFile(composeFile: string): string | undefined {
  // Best-effort extraction of the `image:` line under the `cortex:`
  // service. Not a full YAML parse — but enough to spot whether the
  // compose file points at a registry or just `cortex:local`.
  try {
    const raw = readFileSync(composeFile, "utf-8");
    const lines = raw.split(/\r?\n/);
    let inCortex = false;
    for (const line of lines) {
      if (/^\s*cortex:\s*$/.test(line)) {
        inCortex = true;
        continue;
      }
      if (inCortex) {
        // Leaving the service block on a non-indented line that's not
        // a comment.
        if (/^[^\s#]/.test(line)) break;
        const m = line.match(/^\s*image:\s*(\S+)/);
        if (m && m[1]) return m[1];
      }
    }
  } catch {
    // Fall through — caller will treat as "unknown"
  }
  return undefined;
}

async function runCmd(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`cortex update: ${cmd} failed — ${err.message}\n`);
      resolve(127);
    });
  });
}

interface UpdateOptions {
  build: boolean;
  skipPull: boolean;
  yes: boolean;
}

function parseArgs(args: readonly string[]): UpdateOptions {
  const opts: UpdateOptions = { build: false, skipPull: false, yes: false };
  for (const a of args) {
    if (a === "--build") opts.build = true;
    else if (a === "--skip-pull") opts.skipPull = true;
    else if (a === "-y" || a === "--yes") opts.yes = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(UPDATE_HELP);
      process.exit(0);
    } else {
      process.stderr.write(`cortex update: unknown flag '${a}'\n`);
      process.stderr.write(UPDATE_HELP);
      process.exit(2);
    }
  }
  return opts;
}

const UPDATE_HELP = `Usage: cortex update [options]

Pulls the latest cortex image and restarts the running container in
place. Workspace state (under PRZM_CORTEX_HOME_HOST) is preserved.

Options:
  --build       Build the image locally instead of pulling. Runs
                'git pull --ff-only' first when inside a git checkout.
                Use this when the compose file points at a local image
                tag (e.g. 'cortex:local') with no registry.
  --skip-pull   Skip 'docker compose pull' / 'git pull' and just
                recreate the container with whatever's already cached
                locally.
  -y, --yes     Don't prompt before restarting.
  -h, --help    Show this help.
`;

export async function runUpdate(args: readonly string[]): Promise<number> {
  const opts = parseArgs(args);
  const composeFile = locateComposeFile();
  if (!composeFile) {
    process.stderr.write(
      "cortex update: couldn't find docker-compose.yml. Run this from inside " +
        "a Cortex checkout, or cd to a directory that has one.\n",
    );
    return 2;
  }
  const cwd = path.dirname(composeFile);
  const image = composeImageFromFile(composeFile);
  const looksLocal = !image || /:local$|^cortex:local$/.test(image);
  const mode = opts.build ? "build" : looksLocal ? "build" : "pull";

  if (mode === "build" && !opts.build) {
    process.stdout.write(
      `cortex update: compose image is '${image ?? "<unset>"}' — looks local. ` +
        "Falling back to --build mode. Pass --build explicitly to silence " +
        "this message, or update docker-compose.yml to reference a registry " +
        "image (e.g. ghcr.io/onenomad-llc/przm-cortex:latest) for fast pull-only updates.\n",
    );
  }

  // Step 1: refresh image (pull from registry OR git+build)
  if (!opts.skipPull) {
    if (mode === "pull") {
      process.stdout.write(`\n→ pulling latest image (${image})...\n`);
      const code = await runCmd("docker", ["compose", "pull", "cortex"], cwd);
      if (code !== 0) {
        process.stderr.write("cortex update: docker compose pull failed.\n");
        return code;
      }
    } else {
      if (isInsideGitRepo(cwd)) {
        process.stdout.write("\n→ git pull --ff-only...\n");
        const code = await runCmd("git", ["pull", "--ff-only"], cwd);
        if (code !== 0) {
          process.stderr.write(
            "cortex update: git pull failed (likely non-fast-forward or " +
              "dirty tree). Resolve manually, then retry with --skip-pull.\n",
          );
          return code;
        }
      }
      process.stdout.write("\n→ building cortex image locally...\n");
      const code = await runCmd(
        "docker",
        ["compose", "build", "cortex"],
        cwd,
      );
      if (code !== 0) {
        process.stderr.write("cortex update: docker compose build failed.\n");
        return code;
      }
    }
  }

  // Step 2: recreate just the cortex container (leave deps alone)
  process.stdout.write("\n→ recreating cortex container...\n");
  const upCode = await runCmd(
    "docker",
    ["compose", "up", "-d", "--no-deps", "cortex"],
    cwd,
  );
  if (upCode !== 0) {
    process.stderr.write("cortex update: docker compose up failed.\n");
    return upCode;
  }

  // Step 3: brief health snapshot so the operator sees the new image
  process.stdout.write("\n→ status:\n");
  await runCmd("docker", ["compose", "ps", "cortex"], cwd);
  process.stdout.write("\n→ last 20 log lines:\n");
  await runCmd(
    "docker",
    ["compose", "logs", "--tail", "20", "cortex"],
    cwd,
  );
  process.stdout.write("\n✓ cortex updated.\n");
  return 0;
}
