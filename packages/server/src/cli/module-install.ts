import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  addPrivateModule,
  listPrivateModulesFromConfig,
  removePrivateModule,
} from "./config-mutation.js";
import { resolveConfigPath } from "./config-path.js";
import { getActiveWorkspace } from "./workspace/manager.js";

/**
 * `cortex module install <source>` — install a private module into
 * Cortex without hand-editing YAML + compose.
 *
 * A "private module" is a separate git repo (or an already-cloned
 * directory) that exports an `mcpTools` array from its compiled
 * `dist/index.js`. See `server/src/private-modules.ts` for the
 * runtime loader contract and ADR-018 for the session-scoped
 * workspace story these modules live inside.
 *
 * This command does three things:
 *   1. Brings the module onto the host filesystem (git clone, or
 *      accepts an existing local path).
 *   2. Builds it (pnpm install + pnpm build), unless --no-build.
 *   3. Adds its *container-visible* path to the active workspace's
 *      cortex.local.yaml `privateModules` list.
 *
 * Restart cortex (`cortex up`) afterward to pick up the module.
 *
 * Why the container-path-translation: ADR-017 made Docker compose
 * the primary run path. Cortex reads cortex.yaml from inside the
 * container, so `privateModules` entries need to be paths Cortex
 * will see there. We install modules under $PRZM_CORTEX_HOME_HOST/modules/
 * which is already bind-mounted at /root/.cortex in the container —
 * no docker-compose.yml edits required.
 */

interface InstallFlags {
  source?: string;
  name?: string;
  noBuild: boolean;
  pathOnly: boolean;
  native: boolean;
}

/**
 * Progress event emitted during install. The dashboard API streams
 * these over SSE so the UI can show a live install log; the CLI
 * prints them to stdout. Non-progress final outcome goes in the
 * resolved `InstallResult`.
 */
export type InstallEvent =
  | { type: "log"; line: string }
  | { type: "step"; name: string }
  | { type: "warn"; line: string };

export type ProgressHandler = (event: InstallEvent) => void;

export interface InstallOptions {
  /** Git URL or local path. */
  source: string;
  /** Override the derived module name. */
  name?: string;
  /** Skip pnpm install + pnpm build. */
  noBuild?: boolean;
  /** Register the source path as-is instead of cloning/copying. */
  pathOnly?: boolean;
  /** Write host paths to config instead of container paths. */
  native?: boolean;
  /** Override the host install root (default: PRZM_CORTEX_HOME_HOST/modules). */
  hostRoot?: string;
  /** Override the container modules root (default: /root/.cortex/modules). */
  containerRoot?: string;
  /** Override the config write target (default: active workspace). */
  writeTargetRoot?: string;
  /** Callback for streaming progress. Default: no-op. */
  onProgress?: ProgressHandler;
}

export interface InstallResult {
  ok: boolean;
  name: string;
  hostPath: string;
  containerPath: string;
  /** The cortex.local.yaml path that got written. */
  configPath?: string;
  /** `true` when the path was newly added, `false` when already registered. */
  added?: boolean;
  /** Tools the module exports, discovered during validation. */
  toolNames: string[];
  /** Terminal reason when `ok: false`. */
  error?: string;
}

export async function runModuleCommand(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "install":
      return runInstall(rest);
    case "list":
    case "ls":
      return runList();
    case "remove":
    case "rm":
    case "uninstall":
      return runRemove(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      process.stderr.write(`cortex module: unknown subcommand '${sub}'.\n\n`);
      printHelp();
      return 2;
  }
}

/**
 * Pure install flow. Emits progress events via `onProgress` and
 * resolves with a structured result. The CLI and the dashboard API
 * both call this — progress lines go to stdout + SSE respectively.
 */
export async function installModule(
  opts: InstallOptions,
): Promise<InstallResult> {
  const progress = opts.onProgress ?? (() => undefined);
  const log = (line: string) => progress({ type: "log", line });
  const warn = (line: string) => progress({ type: "warn", line });
  const step = (name: string) => progress({ type: "step", name });

  const hostRoot = opts.hostRoot ?? hostModulesRoot();
  const containerRoot =
    opts.containerRoot ?? (opts.native ? hostRoot : containerModulesRoot());

  const isGit = looksLikeGitUrl(opts.source);

  const name = (opts.name?.trim() || deriveName(opts.source));
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return {
      ok: false,
      name,
      hostPath: "",
      containerPath: "",
      toolNames: [],
      error: `invalid name '${name}' (override with --name=<slug>)`,
    };
  }

  await mkdir(hostRoot, { recursive: true });
  const resolvedHostPath = path.join(hostRoot, name);
  const resolvedContainerPath = posixJoin(containerRoot, name);

  // Step 1: get the source onto disk.
  let hostPath = resolvedHostPath;
  let containerPath = resolvedContainerPath;

  if (opts.pathOnly) {
    step("register-existing");
    const abs = path.resolve(opts.source);
    if (!existsSync(abs)) {
      return {
        ok: false,
        name,
        hostPath: abs,
        containerPath: opts.native ? abs : containerPath,
        toolNames: [],
        error: `path '${abs}' doesn't exist`,
      };
    }
    log(`Using existing path: ${abs}`);
    hostPath = abs;
    containerPath = opts.native
      ? abs
      : toContainerPath(abs, hostRoot, containerRoot) ?? abs;
  } else {
    if (existsSync(hostPath)) {
      const statInfo = await stat(hostPath).catch(() => undefined);
      if (statInfo?.isDirectory()) {
        return {
          ok: false,
          name,
          hostPath,
          containerPath,
          toolNames: [],
          error: `${hostPath} already exists. Remove it first or pass a different --name.`,
        };
      }
    }

    if (isGit) {
      step("clone");
      log(`Cloning ${opts.source} -> ${hostPath}`);
      const code = await runSpawn(
        "git",
        ["clone", "--depth=1", opts.source, hostPath],
        { onLine: log },
      );
      if (code !== 0) {
        return {
          ok: false,
          name,
          hostPath,
          containerPath,
          toolNames: [],
          error: `git clone failed (exit ${code})`,
        };
      }
    } else {
      step("copy");
      const abs = path.resolve(opts.source);
      if (!existsSync(abs)) {
        return {
          ok: false,
          name,
          hostPath,
          containerPath,
          toolNames: [],
          error: `source path '${abs}' doesn't exist`,
        };
      }
      log(`Copying ${abs} -> ${hostPath}`);
      const code = await copyTree(abs, hostPath);
      if (code !== 0) {
        return {
          ok: false,
          name,
          hostPath,
          containerPath,
          toolNames: [],
          error: `copy failed (exit ${code})`,
        };
      }
    }
  }

  // Step 2: build.
  if (!opts.noBuild) {
    step("build");
    const code = await buildModule(hostPath, { onLine: log });
    if (code !== 0) {
      return {
        ok: false,
        name,
        hostPath,
        containerPath,
        toolNames: [],
        error: `build failed (exit ${code}). Files at ${hostPath}; rerun with noBuild=true to register without rebuilding.`,
      };
    }
  }

  // Step 3: validate.
  step("validate");
  const validation = await validateModule(hostPath);
  if (!validation.ok) {
    return {
      ok: false,
      name,
      hostPath,
      containerPath,
      toolNames: [],
      error: `validation failed — ${validation.reason}`,
    };
  }
  log(`Validated. Tools: ${validation.toolNames.join(", ") || "(none)"}`);

  // Step 4: register.
  step("register");
  const repoRoot = opts.writeTargetRoot ?? (await resolveWriteTargetRoot());
  const { filePath, added } = await addPrivateModule(
    { repoRoot },
    containerPath,
  );
  if (!added) warn(`Path was already registered in ${filePath}.`);
  log(`${added ? "Registered" : "Already registered"} in ${filePath}`);

  return {
    ok: true,
    name,
    hostPath,
    containerPath,
    configPath: filePath,
    added,
    toolNames: validation.toolNames,
  };
}

async function runInstall(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args);
  if (!flags.source) {
    process.stderr.write("cortex module install: missing <source>.\n\n");
    printHelp();
    return 2;
  }

  const result = await installModule({
    source: flags.source,
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.noBuild ? { noBuild: true } : {}),
    ...(flags.pathOnly ? { pathOnly: true } : {}),
    ...(flags.native ? { native: true } : {}),
    onProgress: (event) => {
      if (event.type === "log") process.stdout.write(`${event.line}\n`);
      else if (event.type === "warn")
        process.stderr.write(`${event.line}\n`);
      else if (event.type === "step")
        process.stdout.write(`\n[${event.name}]\n`);
    },
  });

  if (!result.ok) {
    process.stderr.write(`cortex module install: ${result.error}\n`);
    return 1;
  }

  process.stdout.write(
    `\nModule: ${result.name}\n` +
      `  Host path:      ${result.hostPath}\n` +
      `  Container path: ${result.containerPath}\n` +
      `  Tools:          ${result.toolNames.join(", ") || "(none)"}\n` +
      `\nRestart cortex to pick it up:  cortex down && cortex up\n`,
  );
  return 0;
}

async function runList(): Promise<number> {
  const repoRoot = await resolveWriteTargetRoot();
  const configured = await listPrivateModulesFromConfig({ repoRoot });
  if (configured.length === 0) {
    process.stdout.write(
      "No private modules registered. Install one with:\n" +
        "  cortex module install <git-url>\n",
    );
    return 0;
  }
  const hostRoot = hostModulesRoot();
  const containerRoot = containerModulesRoot();
  process.stdout.write("Private modules:\n");
  for (const containerPath of configured) {
    const hostPath = toHostPath(containerPath, containerRoot, hostRoot) ?? containerPath;
    const present = existsSync(hostPath);
    const distPresent = existsSync(path.join(hostPath, "dist", "index.js"));
    const status = !present
      ? "missing on host"
      : !distPresent
        ? "not built"
        : "ready";
    process.stdout.write(
      `  ${path.basename(containerPath).padEnd(30)}  ${status}\n` +
        `    container: ${containerPath}\n` +
        `    host:      ${hostPath}\n`,
    );
  }
  return 0;
}

async function runRemove(args: readonly string[]): Promise<number> {
  const target = args[0];
  if (!target) {
    process.stderr.write(
      "cortex module remove: missing <name-or-path>. Run `cortex module list` to see what's installed.\n",
    );
    return 2;
  }
  const repoRoot = await resolveWriteTargetRoot();
  const current = await listPrivateModulesFromConfig({ repoRoot });

  // Accept the full container path OR just the basename. The latter
  // is how `cortex module list` names them.
  const match =
    current.find((p) => p === target) ??
    current.find((p) => path.basename(p) === target);
  if (!match) {
    process.stderr.write(
      `cortex module remove: '${target}' isn't registered. Known: ${
        current.map((p) => path.basename(p)).join(", ") || "(none)"
      }\n`,
    );
    return 1;
  }
  const { filePath, removed } = await removePrivateModule(
    { repoRoot },
    match,
  );
  if (!removed) {
    process.stderr.write("cortex module remove: nothing changed.\n");
    return 1;
  }
  process.stdout.write(
    `Unregistered '${match}' from ${filePath}.\n` +
      `Files on disk were NOT deleted. Remove them manually if you want:\n` +
      `  rm -rf ${toHostPath(match, containerModulesRoot(), hostModulesRoot()) ?? match}\n` +
      `Restart cortex to apply:  cortex down && cortex up\n`,
  );
  return 0;
}

// ---- helpers ---------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    `Usage:\n` +
      `  cortex module install <git-url>          # clone, build, register\n` +
      `  cortex module install <local-path>       # copy, build, register\n` +
      `  cortex module install <path> --path-only # register existing checkout in place\n` +
      `  cortex module list                       # show installed modules + status\n` +
      `  cortex module remove <name>              # unregister (keeps files)\n\n` +
      `Flags for install:\n` +
      `  --name=<slug>   Override the module name (default: derived from source)\n` +
      `  --no-build      Skip pnpm install + pnpm build (for already-built modules)\n` +
      `  --path-only     Don't copy/clone — register the path as-is\n` +
      `  --native        Write host paths to config (no Docker translation)\n\n` +
      `Default install target: $PRZM_CORTEX_HOME_HOST/modules/<name>\n` +
      `                        (or ./.cortex-data/modules/<name> when unset)\n`,
  );
}

function parseFlags(args: readonly string[]): InstallFlags {
  const flags: InstallFlags = {
    noBuild: false,
    pathOnly: false,
    native: false,
  };
  for (const a of args) {
    if (a === "--no-build") flags.noBuild = true;
    else if (a === "--path-only") flags.pathOnly = true;
    else if (a === "--native") flags.native = true;
    else if (a.startsWith("--name=")) flags.name = a.slice("--name=".length);
    else if (a.startsWith("--")) {
      // Unknown flag — tolerate silently so a future flag doesn't crash
      // an older binary. The user would rather see the module install than
      // a parse error.
      continue;
    } else if (!flags.source) flags.source = a;
  }
  return flags;
}

export function looksLikeGitUrl(s: string): boolean {
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("git@") ||
    s.startsWith("ssh://") ||
    s.endsWith(".git")
  );
}

export function deriveName(source: string): string {
  // Strip trailing .git, path segments, and a leading git@host: prefix.
  let last = source.replace(/\.git$/, "");
  last = last.replace(/\/$/, "");
  const gitAt = last.indexOf(":");
  if (last.startsWith("git@") && gitAt !== -1) {
    last = last.slice(gitAt + 1);
  }
  const slash = last.lastIndexOf("/");
  if (slash !== -1) last = last.slice(slash + 1);
  // Normalize a user-friendly slug.
  return last.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function hostModulesRoot(): string {
  const home = process.env.PRZM_CORTEX_HOME_HOST;
  if (home && home.trim().length > 0) {
    return path.resolve(home, "modules");
  }
  // Matches docker-compose.yml's default: `./.cortex-data` relative to
  // cwd. In practice the user runs `cortex module install` from the
  // cortex repo root; if they're elsewhere, they can set PRZM_CORTEX_HOME_HOST.
  return path.resolve(process.cwd(), ".cortex-data", "modules");
}

function containerModulesRoot(): string {
  // The cortex container mounts the host root at /root/.cortex.
  return "/root/.cortex/modules";
}

/** Translate a container path back to a host path, or undefined if it's outside the mount. */
export function toHostPath(
  containerPath: string,
  containerRoot: string,
  hostRoot: string,
): string | undefined {
  const normalized = containerPath.replace(/\\/g, "/");
  const cRoot = containerRoot.replace(/\\/g, "/");
  if (!normalized.startsWith(cRoot)) return undefined;
  const rel = normalized.slice(cRoot.length).replace(/^\/+/, "");
  return path.join(hostRoot, rel);
}

/** Translate a host path to its equivalent container path. */
export function toContainerPath(
  hostPath: string,
  hostRoot: string,
  containerRoot: string,
): string | undefined {
  const absHost = path.resolve(hostPath);
  const absRoot = path.resolve(hostRoot);
  if (!absHost.startsWith(absRoot)) return undefined;
  const rel = absHost
    .slice(absRoot.length)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  return posixJoin(containerRoot, rel);
}

function posixJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * Where does the CLI write cortex.local.yaml? Preference order:
 *   1. Active workspace path (matches runtime resolution in
 *      config-path.ts).
 *   2. The dir holding whatever cortex.yaml `resolveConfigPath` finds
 *      by walking up from cwd.
 *   3. CWD as a last resort (caller will hit a file-not-found).
 */
async function resolveWriteTargetRoot(): Promise<string> {
  const ws = await getActiveWorkspace();
  if (ws) return ws.path;
  const cfg = resolveConfigPath();
  // cfg = <root>/config/cortex.yaml → root = parent of config dir
  const configDir = path.dirname(cfg);
  return path.dirname(configDir);
}

async function buildModule(
  dir: string,
  opts: { onLine?: (line: string) => void } = {},
): Promise<number> {
  // pnpm is the preferred package manager in the Cortex ecosystem but
  // the module author may have used npm or yarn. Fall back in order so
  // the install works regardless. pnpm first because it handles
  // workspaces cleanly and is what Cortex itself uses.
  const pm = await detectPackageManager(dir);
  opts.onLine?.(`Installing with ${pm}...`);
  let code = await runSpawn(pm, ["install"], { cwd: dir, ...opts });
  if (code !== 0) return code;
  opts.onLine?.(`Building with ${pm} run build...`);
  code = await runSpawn(pm, ["run", "build"], { cwd: dir, ...opts });
  return code;
}

async function detectPackageManager(dir: string): Promise<"pnpm" | "npm" | "yarn"> {
  // Lockfile wins. If none, default to pnpm.
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "package-lock.json"))) return "npm";
  return "pnpm";
}

async function validateModule(
  dir: string,
): Promise<
  | { ok: true; toolNames: string[] }
  | { ok: false; reason: string }
> {
  const entry = path.join(dir, "dist", "index.js");
  if (!existsSync(entry)) {
    return {
      ok: false,
      reason: `${entry} not found. Did the build succeed?`,
    };
  }
  try {
    const mod = (await import(pathToFileURL(entry).href)) as {
      mcpTools?: unknown;
    };
    if (!Array.isArray(mod.mcpTools)) {
      return {
        ok: false,
        reason: `${entry} does not export \`mcpTools\` as an array.`,
      };
    }
    const toolNames: string[] = [];
    for (const t of mod.mcpTools) {
      if (
        t &&
        typeof t === "object" &&
        typeof (t as { name?: unknown }).name === "string"
      ) {
        toolNames.push((t as { name: string }).name);
      }
    }
    return { ok: true, toolNames };
  } catch (err) {
    return {
      ok: false,
      reason: `import of ${entry} threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function copyTree(src: string, dst: string): Promise<number> {
  // Node's cp with recursive is simpler + more portable than spawning
  // xcopy/cp. Mirror git clone's behavior of skipping node_modules and
  // dist since they'll be rebuilt anyway.
  const { cp } = await import("node:fs/promises");
  try {
    await cp(src, dst, {
      recursive: true,
      filter: (source) => {
        const rel = path.relative(src, source);
        if (rel === "") return true;
        const top = rel.split(/[\\/]/)[0];
        return top !== "node_modules" && top !== "dist" && top !== ".git";
      },
    });
    return 0;
  } catch (err) {
    process.stderr.write(
      `copy error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    // Clean up a half-written target so a retry starts fresh.
    await rm(dst, { recursive: true, force: true });
    return 1;
  }
}

function runSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string; onLine?: (line: string) => void } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const stdio: "inherit" | "pipe" = opts.onLine ? "pipe" : "inherit";
    const child = spawn(cmd, args, {
      stdio,
      cwd: opts.cwd,
      // On Windows `git` / `pnpm` are .cmd shims that need shell:true.
      shell: os.platform() === "win32",
    });
    if (opts.onLine && child.stdout && child.stderr) {
      const forwardLines = (stream: NodeJS.ReadableStream) => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            opts.onLine?.(line);
          }
        });
        stream.on("end", () => {
          if (buf.length > 0) opts.onLine?.(buf);
        });
      };
      forwardLines(child.stdout);
      forwardLines(child.stderr);
    }
    child.on("error", (err) => {
      (opts.onLine ?? ((l: string) => process.stderr.write(`${l}\n`)))(
        `spawn ${cmd}: ${err.message}`,
      );
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
