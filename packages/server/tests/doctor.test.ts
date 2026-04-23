import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEnvRefs, runDoctor } from "../src/cli/doctor.js";

const tmps: string[] = [];

afterEach(async () => {
  for (const t of tmps.splice(0)) {
    await rm(t, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeRepo(cfgYaml: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cortex-doctor-"));
  tmps.push(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "cortex.yaml"), cfgYaml, "utf8");
  return root;
}

async function withEnv<T>(
  extra: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(extra)) {
    saved[k] = process.env[k];
    if (extra[k] === undefined) delete process.env[k];
    else process.env[k] = extra[k]!;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("collectEnvRefs", () => {
  it("extracts all ${VAR} references outside comments", () => {
    const yaml = [
      "# commented ${SHOULD_NOT_SEE}",
      "key: ${SEEN}",
      "nested:",
      "  inner: ${ALSO_SEEN}",
      "  # another ${IGNORED}",
    ].join("\n");
    const { refs } = collectEnvRefs(yaml);
    expect([...refs].sort()).toEqual(["ALSO_SEEN", "SEEN"]);
  });

  it("reports refs with unset or empty env vars as missing", async () => {
    const yaml = "a: ${DOC_A}\nb: ${DOC_B}";
    await withEnv({ DOC_A: "x", DOC_B: undefined }, async () => {
      const { missing } = collectEnvRefs(yaml);
      expect(missing).toEqual(["DOC_B"]);
    });
  });
});

describe("runDoctor", () => {
  it("exits 0 when every check passes on a minimal but valid config", async () => {
    const yaml = [
      "llm:",
      "  providers:",
      "    ollama:",
      '      package: "@onenomad/cortex-provider-ollama"',
      "      enabled: true",
      "      config: { host: http://localhost:11434 }",
      "  tasks:",
      "    default: { provider: ollama, model: qwen3:14b }",
      "  fallbackChain: []",
      "adapters: {}",
      "memory: { primary: engram }",
      "webhooks: { enabled: false, host: 0.0.0.0, port: 4040 }",
    ].join("\n");
    const root = await makeRepo(yaml);
    await withEnv(
      { CORTEX_CONFIG_PATH: path.join(root, "config", "cortex.yaml") },
      async () => {
        const code = await captureStdout(() => runDoctor([]));
        expect(code).toBe(0);
      },
    );
  });

  it("FAILs when an enabled adapter is missing its required secrets", async () => {
    const yaml = [
      "llm:",
      "  providers:",
      "    ollama:",
      '      package: "@onenomad/cortex-provider-ollama"',
      "      enabled: true",
      "      config: {}",
      "  tasks:",
      "    default: { provider: ollama, model: qwen3:14b }",
      "  fallbackChain: []",
      "adapters:",
      "  confluence:",
      '    package: "@onenomad/cortex-adapter-confluence"',
      "    enabled: true",
      "    config: { workspace: yourcompany }",
      "memory: { primary: engram }",
      "webhooks: { enabled: false, host: 0.0.0.0, port: 4040 }",
    ].join("\n");
    const root = await makeRepo(yaml);
    await withEnv(
      {
        CORTEX_CONFIG_PATH: path.join(root, "config", "cortex.yaml"),
        ATLASSIAN_EMAIL: undefined,
        ATLASSIAN_API_TOKEN: undefined,
      },
      async () => {
        const { code, stdout } = await captureOutput(() => runDoctor([]));
        expect(code).toBe(1);
        expect(stdout).toMatch(/confluence[\s\S]*missing secrets:.*ATLASSIAN/);
      },
    );
  });

  it("runs live probes behind --connect and FAILs on an unreachable engram binary", async () => {
    const yaml = [
      "llm:",
      "  providers:",
      "    ollama:",
      '      package: "@onenomad/cortex-provider-ollama"',
      "      enabled: true",
      "      config: { host: http://localhost:11434 }",
      "  tasks:",
      "    default: { provider: ollama, model: qwen3:14b }",
      "  fallbackChain: []",
      "adapters: {}",
      "memory:",
      "  primary: engram",
      "  engram:",
      "    command: cortex-doctor-bogus-engram-binary",
      "webhooks: { enabled: false, host: 0.0.0.0, port: 4040 }",
    ].join("\n");
    const root = await makeRepo(yaml);
    await withEnv(
      { CORTEX_CONFIG_PATH: path.join(root, "config", "cortex.yaml") },
      async () => {
        const { code, stdout } = await captureOutput(() =>
          runDoctor(["--connect"]),
        );
        expect(code).toBe(1);
        expect(stdout).toMatch(/engram live probe/);
        expect(stdout).toMatch(/\[FAIL\]/);
      },
    );
  }, 30_000);

  it("skips live probes when --connect is not passed", async () => {
    const yaml = [
      "llm:",
      "  providers:",
      "    ollama:",
      '      package: "@onenomad/cortex-provider-ollama"',
      "      enabled: true",
      "      config: { host: http://localhost:11434 }",
      "  tasks:",
      "    default: { provider: ollama, model: qwen3:14b }",
      "  fallbackChain: []",
      "adapters: {}",
      "memory:",
      "  primary: engram",
      "  engram:",
      "    command: cortex-doctor-bogus-engram-binary",
      "webhooks: { enabled: false, host: 0.0.0.0, port: 4040 }",
    ].join("\n");
    const root = await makeRepo(yaml);
    await withEnv(
      { CORTEX_CONFIG_PATH: path.join(root, "config", "cortex.yaml") },
      async () => {
        const { code, stdout } = await captureOutput(() => runDoctor([]));
        expect(code).toBe(0);
        expect(stdout).not.toMatch(/engram live probe/);
        expect(stdout).not.toMatch(/pgvector live probe/);
      },
    );
  });

  it("reports env refs as FAIL when the referenced var is unset", async () => {
    const yaml = [
      "llm:",
      "  providers:",
      "    ollama:",
      '      package: "@onenomad/cortex-provider-ollama"',
      "      enabled: true",
      "      config: { host: '${OLLAMA_HOST}' }",
      "  tasks:",
      "    default: { provider: ollama, model: qwen3:14b }",
      "  fallbackChain: []",
      "adapters: {}",
      "memory: { primary: engram }",
      "webhooks: { enabled: false, host: 0.0.0.0, port: 4040 }",
    ].join("\n");
    const root = await makeRepo(yaml);
    await withEnv(
      {
        CORTEX_CONFIG_PATH: path.join(root, "config", "cortex.yaml"),
        OLLAMA_HOST: undefined,
      },
      async () => {
        const { code, stdout } = await captureOutput(() => runDoctor([]));
        expect(code).toBe(1);
        expect(stdout).toMatch(/env var references[\s\S]*unset:.*OLLAMA_HOST/);
      },
    );
  });
});

async function captureStdout(fn: () => Promise<number>): Promise<number> {
  const { code } = await captureOutput(fn);
  return code;
}

async function captureOutput(
  fn: () => Promise<number>,
): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: (s: string) => boolean }).write = original;
  }
}
