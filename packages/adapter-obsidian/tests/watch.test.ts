import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamContext } from "@onenomad/przm-cortex-core";
import { watchVault } from "../src/watch.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-obsidian-watch-"));
  tempRoots.push(root);
  return root;
}

function makeCtx(): { ctx: StreamContext; abort: () => void } {
  const controller = new AbortController();
  return {
    ctx: {
      signal: controller.signal,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(function (this: unknown) {
          return this;
        }),
      },
    },
    abort: () => controller.abort(),
  };
}

describe("watchVault", () => {
  it("emits RawSourceItems for newly-added markdown files", async () => {
    const vault = await makeVault();
    const { ctx, abort } = makeCtx();

    const iter = watchVault(
      {
        vaultPath: vault,
        ignore: [".obsidian", ".git"],
        maxFileBytes: 1_000_000,
        debounceMs: 50,
      },
      ctx,
    );

    const collected: Array<{ sourceId: string; relativePath: string }> = [];
    const consumer = (async () => {
      for await (const item of iter) {
        const raw = item.raw as { relativePath: string };
        collected.push({ sourceId: item.sourceId, relativePath: raw.relativePath });
        if (collected.length >= 2) break;
      }
    })();

    // chokidar's ignoreInitial means the watcher won't emit for files
    // already on disk at `watch()` time — we create the files after
    // starting the watcher.
    await new Promise((r) => setTimeout(r, 500));
    await writeFile(path.join(vault, "note-a.md"), "# A\n\nbody");
    await mkdir(path.join(vault, "folder"), { recursive: true });
    await writeFile(path.join(vault, "folder", "note-b.md"), "# B\n");
    await consumer;
    abort();

    expect(collected).toHaveLength(2);
    const paths = collected.map((c) => c.relativePath).sort();
    // Always forward-slash regardless of host OS — watcher normalizes
    // so source_ids are portable across Windows and POSIX vaults.
    expect(paths).toEqual(["folder/note-b.md", "note-a.md"].sort());
    for (const item of collected) {
      expect(item.sourceId).toMatch(/^obsidian:/);
    }
  }, 10_000);

  it("skips files larger than maxFileBytes", async () => {
    const vault = await makeVault();
    const { ctx, abort } = makeCtx();

    const iter = watchVault(
      {
        vaultPath: vault,
        ignore: [],
        maxFileBytes: 100,
        debounceMs: 50,
      },
      ctx,
    );

    const collected: Array<{ sourceId: string }> = [];
    const consumer = (async () => {
      for await (const item of iter) {
        collected.push({ sourceId: item.sourceId });
        if (collected.length >= 1) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 500));
    // Oversize file — must be skipped.
    await writeFile(path.join(vault, "big.md"), "x".repeat(500));
    // Small file — should come through.
    await writeFile(path.join(vault, "small.md"), "hi");

    await consumer;
    abort();

    expect(collected).toHaveLength(1);
  }, 10_000);

  it("ignores files under configured ignore prefixes", async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    const { ctx, abort } = makeCtx();

    const iter = watchVault(
      {
        vaultPath: vault,
        ignore: [".obsidian"],
        maxFileBytes: 1_000_000,
        debounceMs: 50,
      },
      ctx,
    );

    const seen: string[] = [];
    const consumer = (async () => {
      for await (const item of iter) {
        seen.push((item.raw as { relativePath: string }).relativePath);
        // Stop after the first real note arrives; the .obsidian write
        // that preceded it is what we want to confirm got filtered.
        if (seen.length >= 1) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 500));
    await writeFile(path.join(vault, ".obsidian", "workspace.json"), "{}");
    await writeFile(path.join(vault, "real.md"), "hi");
    await consumer;
    abort();

    expect(seen).toEqual(["real.md"]);
  }, 10_000);
});
