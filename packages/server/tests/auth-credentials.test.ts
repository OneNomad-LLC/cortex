import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetMigrationGuardForTests,
  clearCortexCredentials,
  credentialsPath,
  loadCortexCredentials,
  migrateLegacyCredentials,
  readSharedCredentials,
  saveCortexCredentials,
  writeSharedCredentials,
} from "../src/auth/credentials.js";

let tmpDir: string;
let sharedFile: string;
let legacyDir: string;
let legacyFile: string;

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cortex-auth-"));
  sharedFile = path.join(tmpDir, "credentials.json");
  legacyDir = path.join(tmpDir, "legacy", "cortex");
  legacyFile = path.join(legacyDir, "credentials.json");

  // Point all path-resolvers at the tmp dir.
  process.env.PYRE_CREDENTIALS_FILE = sharedFile;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, "legacy");
  delete process.env.PRZM_CORTEX_MCP_URL;
  delete process.env.PRZM_CORTEX_MCP_TOKEN;
  _resetMigrationGuardForTests();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await rm(tmpDir, { recursive: true, force: true });
});

describe("credentialsPath", () => {
  it("honors PYRE_CREDENTIALS_FILE env override", () => {
    expect(credentialsPath()).toBe(sharedFile);
  });

  it("explicit path arg wins over env", () => {
    expect(credentialsPath("/tmp/explicit.json")).toBe("/tmp/explicit.json");
  });
});

describe("readSharedCredentials", () => {
  it("returns null when file is missing", () => {
    expect(readSharedCredentials()).toBeNull();
  });

  it("returns null on malformed JSON without throwing", () => {
    writeFileSync(sharedFile, "not json", { encoding: "utf-8" });
    expect(readSharedCredentials()).toBeNull();
  });

  it("returns the parsed object preserving unknown fields", () => {
    writeFileSync(
      sharedFile,
      JSON.stringify({
        api_url: "https://pyre.sh",
        api_key: "sk_pyre_abc",
        cortex: { tenants: [] },
        future_product: { foo: "bar" },
      }),
    );
    const out = readSharedCredentials();
    expect(out?.api_key).toBe("sk_pyre_abc");
    expect((out as Record<string, unknown>).future_product).toEqual({ foo: "bar" });
  });
});

describe("saveCortexCredentials", () => {
  it("preserves engram/persona base fields when writing the cortex section", () => {
    writeSharedCredentials({
      api_url: "https://pyre.sh",
      api_key: "sk_pyre_engram",
      label: "matt-laptop",
      scopes: ["engram", "persona"],
      issued_at: "2026-05-14T00:00:00Z",
    });

    saveCortexCredentials({
      tenants: [{ slug: "acme", mcp_url: "https://acme.cortex.pyre.sh", bearer: "sk_pyre_acme" }],
      active_tenant: "acme",
    });

    const file = readSharedCredentials();
    expect(file?.api_key).toBe("sk_pyre_engram");
    expect(file?.label).toBe("matt-laptop");
    expect(file?.scopes).toEqual(["engram", "persona"]);
    expect(file?.cortex?.active_tenant).toBe("acme");
    expect(file?.cortex?.tenants).toHaveLength(1);
    expect(file?.cortex?.tenants?.[0]?.slug).toBe("acme");
  });

  it("falls back active_tenant to first tenant when the slug isn't in the new list", () => {
    saveCortexCredentials({
      tenants: [{ slug: "acme", mcp_url: "https://acme.cortex.pyre.sh", bearer: "x" }],
      active_tenant: "acme",
    });
    saveCortexCredentials({
      tenants: [{ slug: "beta", mcp_url: "https://beta.cortex.pyre.sh", bearer: "y" }],
    });
    const file = readSharedCredentials();
    expect(file?.cortex?.active_tenant).toBe("beta");
  });

  it("clears active_tenant when tenants list goes empty", () => {
    saveCortexCredentials({
      tenants: [{ slug: "acme", mcp_url: "x", bearer: "y" }],
      active_tenant: "acme",
    });
    saveCortexCredentials({ tenants: [] });
    const file = readSharedCredentials();
    expect(file?.cortex?.tenants).toEqual([]);
    expect(file?.cortex?.active_tenant).toBeUndefined();
  });
});

describe("loadCortexCredentials", () => {
  it("returns mode=local with no tenants when file is missing", () => {
    const creds = loadCortexCredentials();
    expect(creds.mode).toBe("local");
    expect(creds.tenant_count).toBe(0);
    expect(creds.fromEnv).toBe(false);
    expect(creds.mcp_url).toBeUndefined();
  });

  it("env vars override file and report fromEnv=true", () => {
    process.env.PRZM_CORTEX_MCP_URL = "https://env.cortex.example/mcp";
    process.env.PRZM_CORTEX_MCP_TOKEN = "env-bearer";
    saveCortexCredentials({
      tenants: [{ slug: "file", mcp_url: "https://file.cortex.example/mcp", bearer: "file-bearer" }],
      active_tenant: "file",
    });
    const creds = loadCortexCredentials();
    expect(creds.fromEnv).toBe(true);
    expect(creds.mcp_url).toBe("https://env.cortex.example/mcp");
    expect(creds.bearer).toBe("env-bearer");
  });

  it("resolves the active tenant's mcp_url and bearer", () => {
    writeSharedCredentials({
      api_url: "https://pyre.sh",
      label: "matt@example.com",
    });
    saveCortexCredentials({
      tenants: [
        { slug: "acme", mcp_url: "https://acme.cortex.pyre.sh", bearer: "acme-bearer" },
        { slug: "beta", mcp_url: "https://beta.cortex.pyre.sh", bearer: "beta-bearer" },
      ],
      active_tenant: "beta",
    });
    const creds = loadCortexCredentials();
    expect(creds.mode).toBe("cloud");
    expect(creds.tenant_slug).toBe("beta");
    expect(creds.mcp_url).toBe("https://beta.cortex.pyre.sh");
    expect(creds.bearer).toBe("beta-bearer");
    expect(creds.user_email).toBe("matt@example.com");
    expect(creds.login_server).toBe("https://pyre.sh");
    expect(creds.tenant_count).toBe(2);
  });

  it("honors explicit mode=local even with tenants present", () => {
    saveCortexCredentials({
      tenants: [{ slug: "acme", mcp_url: "x", bearer: "y" }],
      active_tenant: "acme",
      mode: "local",
    });
    const creds = loadCortexCredentials();
    expect(creds.mode).toBe("local");
  });
});

describe("clearCortexCredentials", () => {
  it("preserves engram/persona fields and only deletes the cortex section", () => {
    writeSharedCredentials({
      api_url: "https://pyre.sh",
      api_key: "sk_pyre_engram",
      label: "matt-laptop",
    });
    saveCortexCredentials({
      tenants: [{ slug: "acme", mcp_url: "x", bearer: "y" }],
      active_tenant: "acme",
    });

    expect(clearCortexCredentials()).toBe(true);

    const file = readSharedCredentials();
    expect(file?.api_key).toBe("sk_pyre_engram");
    expect(file?.cortex).toBeUndefined();
    expect(existsSync(sharedFile)).toBe(true);
  });

  it("deletes the file entirely when no fields remain", () => {
    saveCortexCredentials({
      tenants: [{ slug: "acme", mcp_url: "x", bearer: "y" }],
      active_tenant: "acme",
    });
    expect(clearCortexCredentials()).toBe(true);
    expect(existsSync(sharedFile)).toBe(false);
  });

  it("returns false when there's no cortex section to clear", () => {
    writeSharedCredentials({ api_key: "sk_pyre_engram" });
    expect(clearCortexCredentials()).toBe(false);
  });

  it("returns false when the file doesn't exist", () => {
    expect(clearCortexCredentials()).toBe(false);
  });
});

describe("migrateLegacyCredentials", () => {
  function writeLegacy(payload: Record<string, unknown>): void {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, JSON.stringify(payload), { encoding: "utf-8" });
  }

  it("no-ops when legacy file is missing", () => {
    expect(migrateLegacyCredentials()).toBe(false);
    expect(existsSync(sharedFile)).toBe(false);
  });

  it("folds legacy cloud creds into the shared file as a single tenant and deletes the legacy file", () => {
    writeLegacy({
      mode: "cloud",
      mcpUrl: "https://acme.cortex.pyre.sh",
      bearer: "sk_pyre_acme",
      tenantSlug: "acme",
      userEmail: "matt@acme.example",
      loginServer: "https://pyre.sh",
      updatedAt: "2026-05-14T00:00:00Z",
    });

    expect(migrateLegacyCredentials()).toBe(true);

    const file = readSharedCredentials();
    expect(file?.label).toBe("matt@acme.example");
    expect(file?.api_url).toBe("https://pyre.sh");
    expect(file?.cortex?.active_tenant).toBe("acme");
    expect(file?.cortex?.tenants).toHaveLength(1);
    expect(file?.cortex?.tenants?.[0]).toEqual({
      slug: "acme",
      mcp_url: "https://acme.cortex.pyre.sh",
      bearer: "sk_pyre_acme",
    });
    expect(existsSync(legacyFile)).toBe(false);
  });

  it("does not overwrite existing engram label/api_url", () => {
    writeSharedCredentials({
      api_url: "https://pyre.sh",
      api_key: "sk_pyre_engram",
      label: "engram-set-label",
    });
    writeLegacy({
      mcpUrl: "https://acme.cortex.pyre.sh",
      bearer: "sk_pyre_acme",
      userEmail: "different@example.com",
      loginServer: "https://other.pyre.sh",
    });

    migrateLegacyCredentials();

    const file = readSharedCredentials();
    expect(file?.label).toBe("engram-set-label");
    expect(file?.api_url).toBe("https://pyre.sh");
    expect(file?.api_key).toBe("sk_pyre_engram");
  });

  it("doesn't duplicate a tenant the user already has", () => {
    saveCortexCredentials({
      tenants: [{ slug: "acme", mcp_url: "https://acme.cortex.pyre.sh", bearer: "old-bearer" }],
      active_tenant: "acme",
    });
    writeLegacy({
      mcpUrl: "https://acme.cortex.pyre.sh",
      bearer: "different-bearer",
      tenantSlug: "acme",
    });

    migrateLegacyCredentials();

    const file = readSharedCredentials();
    expect(file?.cortex?.tenants).toHaveLength(1);
    // First-write-wins on dedup; we don't clobber an existing bearer.
    expect(file?.cortex?.tenants?.[0]?.bearer).toBe("old-bearer");
  });

  it("retires the legacy file even when there's nothing to merge (local-mode legacy)", () => {
    writeLegacy({ mode: "local" });
    migrateLegacyCredentials();
    expect(existsSync(legacyFile)).toBe(false);
    expect(existsSync(sharedFile)).toBe(false);
  });

  it("leaves a malformed legacy file in place for manual inspection", () => {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyFile, "{ malformed", { encoding: "utf-8" });
    migrateLegacyCredentials();
    expect(existsSync(legacyFile)).toBe(true);
  });
});

describe("loadCortexCredentials triggers one-time migration", () => {
  it("merges legacy creds when first load runs", () => {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyFile,
      JSON.stringify({
        mcpUrl: "https://acme.cortex.pyre.sh",
        bearer: "sk_pyre_acme",
        tenantSlug: "acme",
      }),
    );

    const creds = loadCortexCredentials();
    expect(creds.mode).toBe("cloud");
    expect(creds.tenant_slug).toBe("acme");
    expect(creds.mcp_url).toBe("https://acme.cortex.pyre.sh");
    expect(existsSync(legacyFile)).toBe(false);
  });
});
