import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatWriter, readHeartbeat } from "../src/heartbeat.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-hb-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLogger() {
  const noop = vi.fn();
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => makeLogger(),
  };
}

describe("HeartbeatWriter", () => {
  it("flushes state to disk and readHeartbeat parses it", async () => {
    const filePath = path.join(tmpDir, "heartbeat.json");
    const hb = new HeartbeatWriter({
      filePath,
      intervalMs: 60_000,
      logger: makeLogger(),
    });
    hb.registerAdapter("confluence", "0 */6 * * *");
    hb.setUpstream(true, true);
    hb.setMcpConnected(true);
    await hb.start();

    const read = await readHeartbeat(filePath);
    expect(read).not.toBeNull();
    expect(read?.adapters.confluence?.schedule).toBe("0 */6 * * *");
    expect(read?.upstream.engram).toBe(true);
    expect(read?.mcp.connected).toBe(true);

    await hb.stop();
    // stop() unlinks the file.
    const afterStop = await readHeartbeat(filePath);
    expect(afterStop).toBeNull();
  });

  it("tracks adapter run counts + last-run stats", async () => {
    const filePath = path.join(tmpDir, "heartbeat.json");
    const hb = new HeartbeatWriter({
      filePath,
      intervalMs: 60_000,
      logger: makeLogger(),
    });
    hb.registerAdapter("notion", "0 */6 * * *");
    await hb.start();

    hb.markRunBegin("notion");
    hb.markRunEnd("notion", { ingested: 7, errors: 0, durationMs: 420 });
    hb.markRunBegin("notion");
    hb.markRunEnd("notion", { ingested: 3, errors: 1, durationMs: 211 });

    const snap = hb.snapshot();
    const adapter = snap.adapters.notion;
    expect(adapter?.runs).toBe(2);
    expect(adapter?.errors).toBe(1);
    expect(adapter?.lastRunIngested).toBe(3);
    expect(adapter?.lastRunMs).toBe(211);
    expect(adapter?.running).toBe(false);

    await hb.stop();
  });

  it("returns null when no heartbeat file exists", async () => {
    expect(await readHeartbeat(path.join(tmpDir, "nope.json"))).toBeNull();
  });
});
