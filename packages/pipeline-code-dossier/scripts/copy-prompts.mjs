#!/usr/bin/env node
// Copy prompts/*.md into dist/ so they travel with the published package.
import { readdirSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src", "prompts");
const dstDir = path.join(here, "..", "dist", "prompts");

mkdirSync(dstDir, { recursive: true });
for (const f of readdirSync(srcDir)) {
  if (!f.endsWith(".md")) continue;
  copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
}
