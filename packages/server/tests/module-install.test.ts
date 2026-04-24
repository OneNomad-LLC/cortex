import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addPrivateModule,
  listPrivateModulesFromConfig,
  removePrivateModule,
} from "../src/cli/config-mutation.js";
import {
  deriveName,
  looksLikeGitUrl,
  toContainerPath,
  toHostPath,
} from "../src/cli/module-install.js";

describe("looksLikeGitUrl", () => {
  it("accepts https/http URLs", () => {
    expect(looksLikeGitUrl("https://github.com/user/repo.git")).toBe(true);
    expect(looksLikeGitUrl("http://gitlab.example/u/r")).toBe(true);
  });

  it("accepts git@ SCP-style SSH", () => {
    expect(looksLikeGitUrl("git@github.com:user/repo.git")).toBe(true);
  });

  it("accepts ssh:// scheme", () => {
    expect(looksLikeGitUrl("ssh://git@git.example/repo")).toBe(true);
  });

  it("accepts any string ending in .git", () => {
    expect(looksLikeGitUrl("foo.git")).toBe(true);
  });

  it("rejects plain local paths", () => {
    expect(looksLikeGitUrl("../sibling-repo")).toBe(false);
    expect(looksLikeGitUrl("/abs/path")).toBe(false);
    expect(looksLikeGitUrl("C:/Users/m/repo")).toBe(false);
  });
});

describe("deriveName", () => {
  it("strips .git and uses the last path segment", () => {
    expect(deriveName("https://github.com/foo/bar-baz.git")).toBe("bar-baz");
  });

  it("handles SCP-style URLs", () => {
    expect(deriveName("git@github.com:foo/bar-baz.git")).toBe("bar-baz");
  });

  it("handles local paths", () => {
    expect(deriveName("/home/m/code/my-module")).toBe("my-module");
    expect(deriveName("./my-module/")).toBe("my-module");
  });

  it("lowercases and replaces bad chars", () => {
    expect(deriveName("Some Weird Name")).toBe("some-weird-name");
  });
});

describe("toContainerPath / toHostPath (round trip)", () => {
  const hostRoot = path.resolve("/tmp/.cortex-data/modules");
  const containerRoot = "/root/.cortex/modules";

  it("translates host path to container path", () => {
    const host = path.join(hostRoot, "cortex-career-automation");
    const container = toContainerPath(host, hostRoot, containerRoot);
    expect(container).toBe("/root/.cortex/modules/cortex-career-automation");
  });

  it("returns undefined when host path is outside the root", () => {
    const outside = path.resolve("/elsewhere/repo");
    expect(toContainerPath(outside, hostRoot, containerRoot)).toBeUndefined();
  });

  it("translates container path back to host path", () => {
    const host = toHostPath(
      "/root/.cortex/modules/my-mod",
      containerRoot,
      hostRoot,
    );
    expect(host).toBe(path.join(hostRoot, "my-mod"));
  });

  it("returns undefined when container path is outside the mount", () => {
    expect(
      toHostPath("/var/random/stuff", containerRoot, hostRoot),
    ).toBeUndefined();
  });

  it("round-trips a value through both directions", () => {
    const original = path.join(hostRoot, "mod-x");
    const c = toContainerPath(original, hostRoot, containerRoot);
    expect(c).toBeDefined();
    const back = toHostPath(c!, containerRoot, hostRoot);
    expect(back).toBe(original);
  });
});

describe("privateModules config helpers", () => {
  let tmp: string;
  let configDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "cortex-mi-"));
    configDir = path.join(tmp, "config");
    configPath = path.join(configDir, "cortex.yaml");
    await mkdir(configDir, { recursive: true });
    // Seed a minimum cortex.yaml so ensureLocalCopy has a template.
    await writeFile(
      configPath,
      "llm:\n  providers: {}\n  tasks:\n    default: { provider: x, model: y }\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("addPrivateModule creates cortex.local.yaml and adds the entry", async () => {
    const { filePath, added } = await addPrivateModule(
      { repoRoot: tmp },
      "/root/.cortex/modules/alpha",
    );
    expect(added).toBe(true);
    expect(path.basename(filePath)).toBe("cortex.local.yaml");
    const list = await listPrivateModulesFromConfig({ repoRoot: tmp });
    expect(list).toEqual(["/root/.cortex/modules/alpha"]);
  });

  it("adding the same path twice is a no-op", async () => {
    await addPrivateModule(
      { repoRoot: tmp },
      "/root/.cortex/modules/alpha",
    );
    const second = await addPrivateModule(
      { repoRoot: tmp },
      "/root/.cortex/modules/alpha",
    );
    expect(second.added).toBe(false);
    const list = await listPrivateModulesFromConfig({ repoRoot: tmp });
    expect(list).toEqual(["/root/.cortex/modules/alpha"]);
  });

  it("adds additional modules alongside existing ones", async () => {
    await addPrivateModule({ repoRoot: tmp }, "/root/.cortex/modules/alpha");
    await addPrivateModule({ repoRoot: tmp }, "/root/.cortex/modules/beta");
    const list = await listPrivateModulesFromConfig({ repoRoot: tmp });
    expect(list).toEqual([
      "/root/.cortex/modules/alpha",
      "/root/.cortex/modules/beta",
    ]);
  });

  it("removePrivateModule drops the entry", async () => {
    await addPrivateModule({ repoRoot: tmp }, "/root/.cortex/modules/alpha");
    await addPrivateModule({ repoRoot: tmp }, "/root/.cortex/modules/beta");
    const { removed } = await removePrivateModule(
      { repoRoot: tmp },
      "/root/.cortex/modules/alpha",
    );
    expect(removed).toBe(true);
    const list = await listPrivateModulesFromConfig({ repoRoot: tmp });
    expect(list).toEqual(["/root/.cortex/modules/beta"]);
  });

  it("remove of a non-registered path is a no-op", async () => {
    const { removed } = await removePrivateModule(
      { repoRoot: tmp },
      "/root/.cortex/modules/ghost",
    );
    expect(removed).toBe(false);
  });

  it("listPrivateModulesFromConfig returns [] when nothing registered", async () => {
    const list = await listPrivateModulesFromConfig({ repoRoot: tmp });
    expect(list).toEqual([]);
  });

  it("listPrivateModulesFromConfig falls back to the committed template when local is absent", async () => {
    // Write a template-only value (no cortex.local.yaml yet).
    await writeFile(
      configPath,
      "privateModules:\n  - /root/.cortex/modules/seeded\n",
      "utf8",
    );
    const list = await listPrivateModulesFromConfig({ repoRoot: tmp });
    expect(list).toEqual(["/root/.cortex/modules/seeded"]);
  });

  it("ignores non-string entries defensively", async () => {
    const localPath = path.join(configDir, "cortex.local.yaml");
    await writeFile(
      localPath,
      "privateModules:\n  - /ok\n  - 42\n  - null\n  - /also-ok\n",
      "utf8",
    );
    const list = await listPrivateModulesFromConfig({ repoRoot: tmp });
    expect(list).toEqual(["/ok", "/also-ok"]);
  });
});
