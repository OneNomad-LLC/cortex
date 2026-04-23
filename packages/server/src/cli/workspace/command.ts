import path from "node:path";
import {
  createWorkspace,
  findWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  removeWorkspace,
  switchWorkspace,
  workspacePath,
  validateSlug,
} from "./manager.js";
import { readState, updateState } from "./state.js";

/**
 * `cortex workspace <subcommand>` — manage named config + .env +
 * memory state bundles so one Cortex install can serve multiple jobs,
 * clients, or contexts without re-editing files.
 */
export async function runWorkspace(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return sub === undefined ? 2 : 0;
    case "list":
      return runList();
    case "current":
      return runCurrent();
    case "add":
      return runAdd(rest);
    case "switch":
      return runSwitch(rest);
    case "remove":
      return runRemove(rest);
    case "rename":
      return runRename(rest);
    default:
      process.stderr.write(
        `cortex workspace: unknown subcommand '${sub}'\n\n`,
      );
      printUsage();
      return 2;
  }
}

async function runList(): Promise<number> {
  const [workspaces, state] = await Promise.all([
    listWorkspaces(),
    readState(),
  ]);
  if (workspaces.length === 0) {
    process.stdout.write(
      "No workspaces yet. Run `cortex workspace add <slug>` to create one,\n" +
        "or `cortex init` to set up a workspace from scratch.\n",
    );
    return 0;
  }
  const active = state.activeWorkspace;
  const width = Math.max(...workspaces.map((w) => w.slug.length), 8);
  process.stdout.write(`\nWorkspaces (root: ${workspacePath("").slice(0, -1)})\n\n`);
  for (const ws of workspaces) {
    const marker = ws.slug === active ? "* " : "  ";
    process.stdout.write(
      `${marker}${ws.slug.padEnd(width)}  ${ws.path}\n`,
    );
  }
  process.stdout.write("\n* = active\n");
  return 0;
}

async function runCurrent(): Promise<number> {
  const ws = await getActiveWorkspace();
  if (!ws) {
    process.stdout.write(
      "No active workspace. Cortex is using the legacy config path " +
        "(walk-up from cwd, then ~/.cortex/config/cortex.yaml).\n",
    );
    return 0;
  }
  process.stdout.write(`${ws.slug}\n  ${ws.path}\n`);
  return 0;
}

async function runAdd(args: readonly string[]): Promise<number> {
  const parsed = parseAddArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n`);
    printUsage();
    return 2;
  }
  const { slug, fromPath } = parsed;

  try {
    const ws = await createWorkspace({
      slug,
      ...(fromPath ? { fromPath } : {}),
    });
    process.stdout.write(
      `\nCreated workspace '${slug}' at ${ws.path}\n`,
    );
    if (fromPath) {
      process.stdout.write(
        `  Copied config from ${path.resolve(fromPath)}\n`,
      );
    } else {
      process.stdout.write(
        `  Empty workspace. Run \`cortex workspace switch ${slug}\` then \`cortex init\`.\n`,
      );
    }

    // Auto-activate the first workspace created on a fresh install.
    const state = await readState();
    if (!state.activeWorkspace) {
      await updateState({ activeWorkspace: slug });
      process.stdout.write(`\nActivated '${slug}' — this is your first workspace.\n`);
    } else {
      process.stdout.write(
        `\nRun \`cortex workspace switch ${slug}\` to activate it.\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `cortex workspace add: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runSwitch(args: readonly string[]): Promise<number> {
  const slug = args[0];
  if (!slug) {
    process.stderr.write("cortex workspace switch: slug required\n");
    return 2;
  }
  try {
    const ws = await switchWorkspace(slug);
    process.stdout.write(`Switched to workspace '${ws.slug}'\n  ${ws.path}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `cortex workspace switch: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runRemove(args: readonly string[]): Promise<number> {
  const slug = args[0];
  const confirmed = args.includes("--yes") || args.includes("-y");
  if (!slug) {
    process.stderr.write("cortex workspace remove: slug required\n");
    return 2;
  }
  if (!confirmed) {
    process.stderr.write(
      `cortex workspace remove: refusing to delete '${slug}' without --yes.\n` +
        `  Deletes ${workspacePath(slug)} and all of its config + .env. Add --yes to proceed.\n`,
    );
    return 2;
  }
  const existing = await findWorkspace(slug);
  if (!existing) {
    process.stderr.write(`cortex workspace remove: workspace '${slug}' not found\n`);
    return 1;
  }
  try {
    await removeWorkspace(slug);
    process.stdout.write(`Removed workspace '${slug}'\n`);
    const state = await readState();
    if (!state.activeWorkspace) {
      process.stdout.write(
        "No active workspace. Run `cortex workspace switch <slug>` to pick one.\n",
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `cortex workspace remove: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runRename(args: readonly string[]): Promise<number> {
  const [oldSlug, newSlug] = args;
  if (!oldSlug || !newSlug) {
    process.stderr.write("cortex workspace rename: <old> <new> required\n");
    return 2;
  }
  const validated = validateSlug(newSlug);
  if (!validated.ok) {
    process.stderr.write(`cortex workspace rename: ${validated.reason}\n`);
    return 2;
  }
  const existing = await findWorkspace(oldSlug);
  if (!existing) {
    process.stderr.write(`cortex workspace rename: '${oldSlug}' not found\n`);
    return 1;
  }
  if (await findWorkspace(newSlug)) {
    process.stderr.write(`cortex workspace rename: '${newSlug}' already exists\n`);
    return 1;
  }
  // fs.rename across directories is atomic on the same volume — good
  // enough here since both paths live under ~/.cortex.
  const { rename } = await import("node:fs/promises");
  await rename(existing.path, workspacePath(newSlug));
  const state = await readState();
  if (state.activeWorkspace === oldSlug) {
    await updateState({ activeWorkspace: newSlug });
  }
  process.stdout.write(`Renamed '${oldSlug}' → '${newSlug}'\n`);
  return 0;
}

function parseAddArgs(args: readonly string[]):
  | { slug: string; fromPath?: string }
  | { error: string } {
  let slug: string | undefined;
  let fromPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--from") {
      const next = args[++i];
      if (!next) return { error: "--from requires a path" };
      fromPath = next;
    } else if (a.startsWith("--from=")) {
      fromPath = a.slice("--from=".length);
    } else if (a.startsWith("--")) {
      return { error: `unknown flag: ${a}` };
    } else if (!slug) {
      slug = a;
    } else {
      return { error: `unexpected argument: ${a}` };
    }
  }
  if (!slug) return { error: "slug required" };
  const validated = validateSlug(slug);
  if (!validated.ok) return { error: validated.reason };
  const out: { slug: string; fromPath?: string } = { slug };
  if (fromPath) out.fromPath = fromPath;
  return out;
}

function printUsage(): void {
  process.stderr.write(
    `Usage:\n` +
      `  cortex workspace list\n` +
      `  cortex workspace current\n` +
      `  cortex workspace add <slug> [--from <path>]\n` +
      `  cortex workspace switch <slug>\n` +
      `  cortex workspace remove <slug> --yes\n` +
      `  cortex workspace rename <old> <new>\n\n` +
      `Workspaces live at ~/.cortex/workspaces/<slug>/. Each has its own\n` +
      `cortex.yaml, projects.yaml, people.yaml, dashboard.yaml, and .env.\n` +
      `\`cortex workspace switch\` flips the pointer; every command after\n` +
      `that reads the new workspace's config.\n`,
  );
}
