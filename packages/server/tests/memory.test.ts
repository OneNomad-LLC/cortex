import { describe, expect, it, vi } from "vitest";
import type { Logger } from "@cortex/core";
import type { LLMRouter } from "@cortex/llm-core";

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

// Mock the concrete client factories so the memory factory can be exercised
// without Postgres or an Engram subprocess. vi.mock is hoisted, so the
// factory under test picks up these replacements at import time.
const engramHealth = vi.fn();
const engramShutdown = vi.fn();
const pgvectorHealth = vi.fn();
const pgvectorShutdown = vi.fn();

vi.mock("../src/clients/engram.js", () => ({
  createEngramClient: vi.fn(async () => ({
    ingest: async () => ({ id: "e" }),
    search: async () => [],
    healthCheck: engramHealth,
    shutdown: engramShutdown,
  })),
}));

vi.mock("../src/clients/pgvector.js", () => ({
  createPgVectorClient: vi.fn(async () => ({
    ingest: async () => ({ id: "p" }),
    search: async () => [],
    healthCheck: pgvectorHealth,
    shutdown: pgvectorShutdown,
  })),
}));

import { createMemoryClient } from "../src/clients/memory.js";

const baseMemory = {
  primary: "engram" as const,
  engram: { args: [], env: {} },
  pgvector: {
    connectionString: "postgres://fake/db",
    table: "cortex_memories",
    embeddingDim: 768,
    embedTask: "embed",
  },
};

const fakeRouter = {} as unknown as LLMRouter;

describe("createMemoryClient", () => {
  it("returns the primary when healthy", async () => {
    engramHealth.mockResolvedValueOnce({ healthy: true, message: "" });
    const boot = await createMemoryClient({
      memory: baseMemory,
      llmRouter: fakeRouter,
      logger: silentLogger,
    });
    expect(boot.selected).toBe("engram");
    expect(boot.primaryHealthy).toBe(true);
    expect(engramShutdown).not.toHaveBeenCalled();
  });

  it("falls back when primary is unhealthy and fallback is configured", async () => {
    engramHealth.mockResolvedValueOnce({ healthy: false, message: "down" });
    pgvectorHealth.mockResolvedValueOnce({ healthy: true, message: "" });
    const boot = await createMemoryClient({
      memory: { ...baseMemory, fallback: "pgvector" },
      llmRouter: fakeRouter,
      logger: silentLogger,
    });
    expect(boot.selected).toBe("pgvector");
    expect(boot.primaryHealthy).toBe(false);
    // The discarded primary should have been cleanly shut down.
    expect(engramShutdown).toHaveBeenCalled();
  });

  it("throws when primary is unhealthy and no fallback is configured", async () => {
    engramHealth.mockResolvedValueOnce({ healthy: false, message: "down" });
    await expect(
      createMemoryClient({
        memory: baseMemory,
        llmRouter: fakeRouter,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/primary backend 'engram' is unhealthy/);
  });

  it("throws when both primary and fallback are unhealthy", async () => {
    engramHealth.mockResolvedValueOnce({ healthy: false, message: "down" });
    pgvectorHealth.mockResolvedValueOnce({ healthy: false, message: "pg down" });
    await expect(
      createMemoryClient({
        memory: { ...baseMemory, fallback: "pgvector" },
        llmRouter: fakeRouter,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/both primary .* and fallback .* are unhealthy/);
  });

  it("ignores a fallback that points at the same backend as primary", async () => {
    engramHealth.mockResolvedValueOnce({ healthy: false, message: "down" });
    await expect(
      createMemoryClient({
        memory: { ...baseMemory, fallback: "engram" },
        llmRouter: fakeRouter,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/no fallback is configured/);
  });
});
