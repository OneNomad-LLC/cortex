import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspace,
  findWorkspace,
  getActiveWorkspace,
  listWorkspaces,
  removeWorkspace,
  switchWorkspace,
  validateSlug,
} from "../src/cli/workspace/manager.js";
import {
  readState,
  updateState,
  writeState,
} from "../src/cli/workspace/state.js";
import { resolveConfigPath } from "../src/cli/config-path.js";

/**
 * Workspace tests manipulate `~/.cortex/state.json` + the workspaces
 * root, so each test gets its own tmp dir for both — and the env
 * overrides we ship (`PRZM_CORTEX_STATE_PATH`, `PRZM_CORTEX_WORKSPACES_ROOT`)
 * redirect every code path to that tmp dir.
 */
describe("workspaces", () => {
  let tmp: string;
  const originalState = process.env.PRZM_CORTEX_STATE_PATH;
  const originalRoot = process.env.PRZM_CORTEX_WORKSPACES_ROOT;
  const originalConfig = process.env.PRZM_CORTEX_CONFIG_PATH;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "cortex-ws-"));
    process.env.PRZM_CORTEX_STATE_PATH = path.join(tmp, "state.json");
    process.env.PRZM_CORTEX_WORKSPACES_ROOT = path.join(tmp, "workspaces");
    delete process.env.PRZM_CORTEX_CONFIG_PATH;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalState === undefined) delete process.env.PRZM_CORTEX_STATE_PATH;
    else process.env.PRZM_CORTEX_STATE_PATH = originalState;
    if (originalRoot === undefined) delete process.env.PRZM_CORTEX_WORKSPACES_ROOT;
    else process.env.PRZM_CORTEX_WORKSPACES_ROOT = originalRoot;
    if (originalConfig === undefined) delete process.env.PRZM_CORTEX_CONFIG_PATH;
    else process.env.PRZM_CORTEX_CONFIG_PATH = originalConfig;
    await rm(tmp, { recursive: true, force: true });
  });

  describe("validateSlug", () => {
    it("accepts kebab-case slugs", () => {
      expect(validateSlug("elevate-digital")).toEqual({ ok: true });
      expect(validateSlug("alpha")).toEqual({ ok: true });
      expect(validateSlug("a1b2")).toEqual({ ok: true });
    });

    it("rejects bad shapes", () => {
      expect(validateSlug("Elevate").ok).toBe(false);
      expect(validateSlug("has spaces").ok).toBe(false);
      expect(validateSlug("-leading").ok).toBe(false);
      expect(validateSlug("").ok).toBe(false);
    });
  });

  describe("state file", () => {
    it("returns empty state when no file exists", async () => {
      const s = await readState();
      expect(s.version).toBe(1);
      expect(s.activeWorkspace).toBeUndefined();
    });

    it("round-trips an active workspace through writeState", async () => {
      await writeState({ version: 1, activeWorkspace: "alpha" });
      const read = await readState();
      expect(read.activeWorkspace).toBe("alpha");
    });

    it("updateState preserves unrelated fields", async () => {
      await writeState({ version: 1, activeWorkspace: "alpha" });
      await updateState({ activeWorkspace: "beta" });
      const s = await readState();
      expect(s.activeWorkspace).toBe("beta");
      expect(s.version).toBe(1);
    });
  });

  describe("manager", () => {
    it("createWorkspace scaffolds a config dir and lists the workspace", async () => {
      const ws = await createWorkspace({ slug: "elevate" });
      expect(ws.slug).toBe("elevate");
      const list = await listWorkspaces();
      expect(list.map((w) => w.slug)).toEqual(["elevate"]);
      const cfg = await readFile(ws.configPath, "utf8");
      expect(cfg).toContain("New workspace");
    });

    it("createWorkspace --from copies an existing config", async () => {
      const source = path.join(tmp, "repo");
      await mkdir(path.join(source, "config"), { recursive: true });
      await writeFile(
        path.join(source, "config", "cortex.yaml"),
        "llm: { providers: {} }\n",
        "utf8",
      );
      await writeFile(path.join(source, ".env"), "FOO=bar\n", "utf8");

      const ws = await createWorkspace({ slug: "main", fromPath: source });
      const cfg = await readFile(ws.configPath, "utf8");
      expect(cfg).toContain("llm");
      const env = await readFile(ws.envPath, "utf8");
      expect(env).toBe("FOO=bar\n");
    });

    it("createWorkspace refuses duplicates", async () => {
      await createWorkspace({ slug: "dup" });
      await expect(createWorkspace({ slug: "dup" })).rejects.toThrow(
        /already exists/i,
      );
    });

    it("switchWorkspace flips the pointer", async () => {
      await createWorkspace({ slug: "alpha" });
      await createWorkspace({ slug: "beta" });
      await switchWorkspace("beta");
      const active = await getActiveWorkspace();
      expect(active?.slug).toBe("beta");
      await switchWorkspace("alpha");
      const next = await getActiveWorkspace();
      expect(next?.slug).toBe("alpha");
    });

    it("switchWorkspace refuses unknown slugs", async () => {
      await expect(switchWorkspace("nope")).rejects.toThrow(/does not exist/);
    });

    it("removeWorkspace deletes the directory and clears the pointer when active", async () => {
      const ws = await createWorkspace({ slug: "temp" });
      await switchWorkspace("temp");
      await removeWorkspace("temp");
      expect(await findWorkspace("temp")).toBeUndefined();
      const state = await readState();
      expect(state.activeWorkspace).toBeUndefined();
      // Directory is gone.
      await expect(readFile(ws.configPath, "utf8")).rejects.toBeTruthy();
    });
  });

  describe("resolveConfigPath with workspace active", () => {
    it("prefers the active workspace's cortex.yaml over anything else", async () => {
      await createWorkspace({ slug: "alpha" });
      await switchWorkspace("alpha");
      // Put a "repo config" below cwd so walk-up would normally find it.
      const repoConfig = path.join(tmp, "repo", "config", "cortex.yaml");
      await mkdir(path.dirname(repoConfig), { recursive: true });
      await writeFile(repoConfig, "", "utf8");
      process.chdir(path.join(tmp, "repo"));

      const resolved = resolveConfigPath();
      expect(resolved).toBe(
        path.join(tmp, "workspaces", "alpha", "config", "cortex.yaml"),
      );
    });

    it("falls through to walk-up when no workspace is active", async () => {
      const repoConfig = path.join(tmp, "repo", "config", "cortex.yaml");
      await mkdir(path.dirname(repoConfig), { recursive: true });
      await writeFile(repoConfig, "", "utf8");
      process.chdir(path.join(tmp, "repo"));
      const resolved = resolveConfigPath();
      expect(resolved).toBe(repoConfig);
    });

    it("PRZM_CORTEX_CONFIG_PATH still wins over an active workspace", async () => {
      await createWorkspace({ slug: "alpha" });
      await switchWorkspace("alpha");
      const override = path.join(tmp, "override", "cortex.yaml");
      await mkdir(path.dirname(override), { recursive: true });
      await writeFile(override, "", "utf8");
      process.env.PRZM_CORTEX_CONFIG_PATH = override;
      expect(resolveConfigPath()).toBe(override);
    });
  });
});
