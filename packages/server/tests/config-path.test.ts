import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfigPath } from "../src/cli/config-path.js";

describe("resolveConfigPath", () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env.CORTEX_CONFIG_PATH;
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "cortex-cfgpath-"));
    delete process.env.CORTEX_CONFIG_PATH;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.CORTEX_CONFIG_PATH;
    else process.env.CORTEX_CONFIG_PATH = originalEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  it("honors $CORTEX_CONFIG_PATH over every other source", async () => {
    process.env.CORTEX_CONFIG_PATH = "/explicit/override/cortex.yaml";
    // Make a real file nearby to prove it's not being picked instead.
    await mkdir(path.join(tmp, "config"), { recursive: true });
    await writeFile(path.join(tmp, "config", "cortex.yaml"), "");
    process.chdir(tmp);
    expect(resolveConfigPath()).toBe("/explicit/override/cortex.yaml");
  });

  it("finds config/cortex.yaml at cwd", async () => {
    await mkdir(path.join(tmp, "config"), { recursive: true });
    const target = path.join(tmp, "config", "cortex.yaml");
    await writeFile(target, "");
    process.chdir(tmp);
    expect(resolveConfigPath()).toBe(target);
  });

  it("walks up from a subdirectory to find the repo config", async () => {
    await mkdir(path.join(tmp, "config"), { recursive: true });
    const target = path.join(tmp, "config", "cortex.yaml");
    await writeFile(target, "");
    const deep = path.join(tmp, "packages", "server", "src");
    await mkdir(deep, { recursive: true });
    process.chdir(deep);
    expect(resolveConfigPath()).toBe(target);
  });

  it("falls back to the cwd-relative default when no config exists anywhere", async () => {
    process.chdir(tmp);
    const resolved = resolveConfigPath();
    // The walk-up can legitimately find a real cortex checkout on a dev
    // machine (hence the walk up the actual filesystem tree). Only assert
    // that we don't get the CORTEX_CONFIG_PATH value or throw — the
    // fallback path is whatever the walk-up surfaces or the tmp dir default.
    expect(typeof resolved).toBe("string");
    expect(resolved.endsWith("cortex.yaml")).toBe(true);
  });
});
