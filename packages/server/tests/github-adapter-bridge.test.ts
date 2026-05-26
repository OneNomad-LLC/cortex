/**
 * Unit tests for the OAuth → GitHub adapter config bridge.
 *
 * Coverage:
 *   - First-time OAuth login → writes GITHUB_TOKEN + source=oauth and
 *     adds adapters.github to cortex.yaml.
 *   - Repeat OAuth login with same token → no-op writes (idempotent).
 *   - Repeat OAuth login with new token → refreshes GITHUB_TOKEN (token
 *     rotation case).
 *   - Existing PAT in .env → bridge preserves it (skipped_reason set).
 *   - Existing adapters.github block → bridge leaves it alone.
 *
 * Uses a real tmpdir + real file IO so the YAML / dotenv round-trip
 * stays representative. parseYaml + stringifyYaml in
 * github-adapter-bridge.ts already strip comments and reorder keys,
 * which is a fine trade-off for an idempotent declarative state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { bridgeGithubAdapterConfig } from "../src/auth/github-adapter-bridge.js";

function ws(dir: string): {
  slug: string;
  path: string;
  envPath: string;
  configPath: string;
} {
  return {
    slug: "test",
    path: dir,
    envPath: path.join(dir, ".env"),
    configPath: path.join(dir, "config", "cortex.yaml"),
  };
}

describe("bridgeGithubAdapterConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cortex-bridge-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes GITHUB_TOKEN + source=oauth and adds adapters.github on first login", async () => {
    const w = ws(root);
    const result = await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_abc123",
    });

    expect(result.wroteToken).toBe(true);
    expect(result.enabledAdapter).toBe(true);
    expect(result.tokenSource).toBe("oauth");

    const env = readFileSync(w.envPath, "utf8");
    expect(env).toContain("GITHUB_TOKEN=gho_abc123");
    expect(env).toContain("PRZM_CORTEX_GITHUB_TOKEN_SOURCE=oauth");

    const yaml = parseYaml(readFileSync(w.configPath, "utf8")) as {
      adapters?: { github?: { enabled?: boolean; repos?: unknown[] } };
    };
    expect(yaml.adapters?.github?.enabled).toBe(true);
    expect(yaml.adapters?.github?.repos).toEqual([]);
  });

  it("is idempotent — same token, same outcome, no extra writes", async () => {
    const w = ws(root);
    await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_stable",
    });
    const result = await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_stable",
    });

    expect(result.wroteToken).toBe(false);
    expect(result.enabledAdapter).toBe(false); // already declared
    expect(result.tokenSource).toBe("oauth");
  });

  it("refreshes GITHUB_TOKEN when OAuth token rotates", async () => {
    const w = ws(root);
    await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_old",
    });
    const result = await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_new",
    });

    expect(result.wroteToken).toBe(true);
    expect(result.tokenSource).toBe("oauth");
    const env = readFileSync(w.envPath, "utf8");
    expect(env).toContain("GITHUB_TOKEN=gho_new");
    expect(env).not.toContain("gho_old");
  });

  it("preserves a manually-set PAT — does not overwrite", async () => {
    const w = ws(root);
    writeFileSync(w.envPath, "GITHUB_TOKEN=ghp_user_set_pat\n", "utf8");

    const result = await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_from_oauth",
    });

    expect(result.wroteToken).toBe(false);
    expect(result.tokenSource).toBe("pat");
    expect(result.skippedReason).toBe("pat_already_set");

    const env = readFileSync(w.envPath, "utf8");
    expect(env).toContain("GITHUB_TOKEN=ghp_user_set_pat");
    expect(env).not.toContain("gho_from_oauth");
  });

  it("leaves an existing adapters.github block untouched", async () => {
    const w = ws(root);
    // Pre-existing user-configured adapter.
    const configDir = path.dirname(w.configPath);
    require("node:fs").mkdirSync(configDir, { recursive: true });
    writeFileSync(
      w.configPath,
      "adapters:\n  github:\n    enabled: false\n    repos:\n      - owner: acme\n        name: web\n",
      "utf8",
    );

    const result = await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_new",
    });

    expect(result.enabledAdapter).toBe(false);

    const yaml = parseYaml(readFileSync(w.configPath, "utf8")) as {
      adapters?: {
        github?: {
          enabled?: boolean;
          repos?: Array<{ owner: string; name: string }>;
        };
      };
    };
    // User's enabled: false survives.
    expect(yaml.adapters?.github?.enabled).toBe(false);
    // User's repos survive.
    expect(yaml.adapters?.github?.repos).toEqual([
      { owner: "acme", name: "web" },
    ]);
  });

  it("writes cortex.local.yaml when one exists, instead of the base", async () => {
    const w = ws(root);
    const localPath = w.configPath.replace(/\.yaml$/, ".local.yaml");
    require("node:fs").mkdirSync(path.dirname(localPath), {
      recursive: true,
    });
    writeFileSync(localPath, "", "utf8"); // empty local override

    await bridgeGithubAdapterConfig({
      workspace: w,
      oauthToken: "gho_local",
    });

    // Local was written, base wasn't created.
    expect(existsSync(localPath)).toBe(true);
    expect(existsSync(w.configPath)).toBe(false);
    const yaml = parseYaml(readFileSync(localPath, "utf8")) as {
      adapters?: { github?: { enabled?: boolean } };
    };
    expect(yaml.adapters?.github?.enabled).toBe(true);
  });
});
