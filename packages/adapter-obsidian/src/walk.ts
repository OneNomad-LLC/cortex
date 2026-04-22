import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface WalkOptions {
  /** Directory/file names to skip (exact match, relative segment). */
  ignore: ReadonlySet<string>;
  /** Extensions to include (with leading dot). Default: [".md"]. */
  extensions?: string[];
}

/**
 * Recursively walk a vault root and yield markdown files. Skips hidden
 * directories and anything in `ignore`. Returns files in no guaranteed
 * order — caller can sort if needed.
 */
export async function* walkVault(
  root: string,
  opts: WalkOptions,
): AsyncIterable<WalkedFile> {
  const exts = new Set(opts.extensions ?? [".md"]);

  async function* recurse(dir: string): AsyncIterable<WalkedFile> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (opts.ignore.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* recurse(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!exts.has(ext)) continue;

      const info = await stat(abs).catch(() => null);
      if (!info) continue;

      yield {
        absolutePath: abs,
        relativePath: path.relative(root, abs).split(path.sep).join("/"),
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
      };
    }
  }

  yield* recurse(root);
}
