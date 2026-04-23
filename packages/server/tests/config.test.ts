import { describe, expect, it } from "vitest";
import { cortexConfigSchema, expandEnv } from "../src/config.js";

describe("expandEnv", () => {
  it("substitutes process.env matches", () => {
    process.env.TEST_FOO = "bar";
    expect(expandEnv("host: ${TEST_FOO}")).toBe("host: bar");
    delete process.env.TEST_FOO;
  });

  it("throws with a readable list of missing vars", () => {
    delete process.env.NOT_SET_XYZ;
    delete process.env.ALSO_UNSET;
    expect(() => expandEnv("a: ${NOT_SET_XYZ}\nb: ${ALSO_UNSET}")).toThrow(
      /NOT_SET_XYZ, ALSO_UNSET/,
    );
  });

  it("treats empty string as missing", () => {
    process.env.EMPTY_TEST = "";
    expect(() => expandEnv("x: ${EMPTY_TEST}")).toThrow(/EMPTY_TEST/);
    delete process.env.EMPTY_TEST;
  });

  it("skips ${VAR} references inside commented lines", () => {
    const yaml = [
      "llm:",
      "  providers:",
      "    # obsidian: { config: { vaultPath: \"${OBSIDIAN_VAULT_PATH}\" } }",
      "    ollama: {}",
    ].join("\n");
    delete process.env.OBSIDIAN_VAULT_PATH;
    expect(() => expandEnv(yaml)).not.toThrow();
  });
});

describe("cortexConfigSchema", () => {
  it("accepts a minimal valid config", () => {
    const parsed = cortexConfigSchema.parse({
      llm: {
        providers: {
          ollama: {
            package: "@onenomad/cortex-provider-ollama",
            enabled: true,
            config: { host: "http://localhost:11434" },
          },
        },
        tasks: {
          default: { provider: "ollama", model: "qwen3:14b" },
        },
        fallbackChain: [],
      },
      adapters: {},
    });
    expect(parsed.llm.providers.ollama?.enabled).toBe(true);
  });

  it("fills memory defaults when the memory block is absent", () => {
    const parsed = cortexConfigSchema.parse({
      llm: {
        providers: {},
        tasks: { default: { provider: "ollama", model: "qwen3:14b" } },
        fallbackChain: [],
      },
    });
    expect(parsed.memory.primary).toBe("engram");
    expect(parsed.memory.fallback).toBeUndefined();
    expect(parsed.memory.pgvector.embeddingDim).toBe(768);
    expect(parsed.memory.pgvector.table).toBe("cortex_memories");
    expect(parsed.memory.pgvector.embedTask).toBe("embed");
  });

  it("accepts a memory block with pgvector fallback", () => {
    const parsed = cortexConfigSchema.parse({
      llm: {
        providers: {},
        tasks: { default: { provider: "ollama", model: "qwen3:14b" } },
      },
      memory: {
        primary: "engram",
        fallback: "pgvector",
        pgvector: {
          connectionString: "postgres://x:y@host/db",
          embeddingDim: 1024,
        },
      },
    });
    expect(parsed.memory.fallback).toBe("pgvector");
    expect(parsed.memory.pgvector.connectionString).toBe(
      "postgres://x:y@host/db",
    );
    expect(parsed.memory.pgvector.embeddingDim).toBe(1024);
  });

  it("rejects an unknown memory backend", () => {
    expect(() =>
      cortexConfigSchema.parse({
        llm: {
          providers: {},
          tasks: { default: { provider: "ollama", model: "qwen3:14b" } },
        },
        memory: { primary: "nonsense" },
      }),
    ).toThrow();
  });

  it("rejects configs without a default task", () => {
    expect(() =>
      cortexConfigSchema.parse({
        llm: {
          providers: {},
          tasks: {
            structural: { provider: "ollama", model: "qwen3:14b" },
          },
        },
        adapters: {},
      }),
    ).toThrow(/default/);
  });
});
