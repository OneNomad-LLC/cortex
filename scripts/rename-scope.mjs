#!/usr/bin/env node
/**
 * One-shot script: rename every `@cortex/*` workspace package to
 * `@onenomad/przm-cortex-*`. Rewrites package.json names + dependencies,
 * imports across .ts/.tsx, and config references in .yaml/.json.
 *
 * Usage: `node scripts/rename-scope.mjs`
 *
 * Idempotent — running twice is a no-op.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const OLD = "@cortex/";
const NEW = "@onenomad/przm-cortex-";

function listTrackedFiles() {
  // Use `git ls-files` so we respect .gitignore and skip node_modules / dist.
  const out = execSync("git ls-files", {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((rel) =>
      /\.(ts|tsx|json|yaml|yml|md)$/i.test(rel) &&
      !rel.startsWith("node_modules/"),
    );
}

async function main() {
  const files = listTrackedFiles();
  let touched = 0;
  for (const rel of files) {
    const abs = path.join(REPO, rel);
    let content;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (!content.includes(OLD)) continue;
    const next = content.split(OLD).join(NEW);
    if (next !== content) {
      await writeFile(abs, next, "utf8");
      touched += 1;
      process.stdout.write(`rewrote ${rel}\n`);
    }
  }
  process.stdout.write(`\nDone. ${touched} file${touched === 1 ? "" : "s"} updated.\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message ?? err}\n`);
  process.exit(1);
});
