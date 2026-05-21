import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import type { RawSourceItem, StreamContext } from "@onenomad/przm-cortex-core";
import { computeSourceId, contentHash } from "@onenomad/przm-cortex-adapter-sdk";

export interface WatchOptions {
  vaultPath: string;
  ignore: readonly string[];
  maxFileBytes: number;
  /** Debounce rapid saves (editor auto-save fires a lot). Default 750ms. */
  debounceMs?: number;
}

interface PendingChange {
  relativePath: string;
  absolutePath: string;
  /** NodeJS.Timeout; stored as unknown to dodge the platform-specific type. */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Yield a new RawSourceItem each time a note in the vault is saved, added,
 * or modified. The watcher coalesces rapid saves per-file (editors fire
 * several events per Ctrl-S) and rebuilds the source_id from the note's
 * content hash so rewrites become updates, not duplicates — the exact same
 * shape as the scheduled walk, just push-based.
 *
 * Returns on `ctx.signal` abort. Implementations must `await` the `close()`
 * to be sure the chokidar watcher has released its file handles.
 */
export async function* watchVault(
  opts: WatchOptions,
  ctx: StreamContext,
): AsyncIterable<RawSourceItem> {
  const debounce = opts.debounceMs ?? 750;
  const ignored = new Set(opts.ignore);
  const vault = path.resolve(opts.vaultPath);

  // Queue of items ready to emit. The watcher pushes here; the generator
  // awaits a promise each iteration so backpressure is naturally bounded
  // by downstream processItem speed.
  const queue: RawSourceItem[] = [];
  let waiter: ((v: RawSourceItem | null) => void) | undefined;

  const pending = new Map<string, PendingChange>();

  const emit = (item: RawSourceItem): void => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(item);
    } else {
      queue.push(item);
    }
  };

  const flush = async (absolutePath: string): Promise<void> => {
    // Normalize to forward slashes so source_ids are identical whether
    // the vault is accessed from Windows or a POSIX host. This matches
    // the convention downstream code (and Engram metadata) already uses.
    const rel = path
      .relative(vault, absolutePath)
      .split(path.sep)
      .join("/");
    if (!rel || rel.startsWith("..")) return;
    if (!rel.toLowerCase().endsWith(".md")) return;
    for (const seg of rel.split("/")) {
      if (ignored.has(seg)) return;
    }

    try {
      const st = await stat(absolutePath);
      if (st.size > opts.maxFileBytes) {
        ctx.logger.info("obsidian.watch.skipped_large", {
          path: rel,
          sizeBytes: st.size,
        });
        return;
      }
      const source = await readFile(absolutePath, "utf8");
      const sourceId = computeSourceId("obsidian", [rel, contentHash(source)]);
      emit({
        sourceId,
        raw: {
          relativePath: rel,
          absolutePath,
          mtime: st.mtime,
          source,
        },
      });
    } catch (err) {
      ctx.logger.warn("obsidian.watch.read_failed", {
        path: rel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const schedule = (absolutePath: string): void => {
    const prev = pending.get(absolutePath);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      pending.delete(absolutePath);
      void flush(absolutePath);
    }, debounce);
    pending.set(absolutePath, {
      relativePath: path.relative(vault, absolutePath),
      absolutePath,
      timer,
    });
  };

  const watcher = chokidar.watch(vault, {
    ignored: (p) => {
      const rel = path.relative(vault, p);
      if (!rel) return false;
      for (const seg of rel.split(/[\\/]/)) {
        if (ignored.has(seg)) return true;
      }
      return false;
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      // Obsidian writes can be multi-step; wait 200ms of quiescence before
      // reading to reduce partial-read errors.
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  watcher.on("add", schedule);
  watcher.on("change", schedule);

  const closeWatcher = async (): Promise<void> => {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
    await watcher.close();
    // Wake any pending consumer so the generator can exit cleanly.
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(null);
    }
  };

  ctx.signal.addEventListener("abort", () => {
    void closeWatcher();
  });

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (ctx.signal.aborted) break;
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      const next = await new Promise<RawSourceItem | null>((resolve) => {
        waiter = resolve;
      });
      if (!next) break; // abort path
      yield next;
    }
  } finally {
    await closeWatcher();
  }
}
