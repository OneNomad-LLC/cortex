/**
 * kb_search — sensitivity-aware retrieval (#4) and trust-aware ranking (#3).
 *
 * Tests that the new `maxSensitivity` and `minTrust` parameters are:
 *   - forwarded from kb_search → search_related → engram.search
 *   - omitted (no filter) when not provided (default behavior preserved)
 *
 * The pgvector-side SQL is tested in memory-pgvector/tests/queries.test.ts
 * and backend.test.ts. This layer only verifies the plumbing from the MCP
 * tool surface down to engram.search.
 */

import { describe, expect, it } from "vitest";
import { kbSearch } from "../src/mcp/tools/kb-search.js";
import { searchRelated } from "../src/mcp/tools/search-related.js";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient, EngramMemory, EngramSearchArgs } from "../src/clients/engram.js";
import { MemoryTypeRegistry } from "@onenomad/przm-cortex-core";

function fakeEngram(
  memories: EngramMemory[],
): EngramClient {
  return {
    async ingest() {
      return { id: "fake" };
    },
    async search() {
      return memories;
    },
    async healthCheck() {
      return { healthy: true, message: "" };
    },
    async shutdown() {
      return;
    },
    async wipeAll() {
      return { deleted: 0 };
    },
    // eslint-disable-next-line require-yield
    async *exportAll() {
      return;
    },
  };
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silentLogger;
  },
};

function makeCtx(
  engram: EngramClient,
  sessionWorkspace?: string,
): ToolContext {
  return {
    engram,
    memoryTypes: new MemoryTypeRegistry(),
    logger: silentLogger,
    ...(sessionWorkspace !== undefined ? { sessionWorkspace } : {}),
  } as ToolContext;
}

// ── search_related forwarding ─────────────────────────────────────────────────

describe("search_related — maxSensitivity forwarding (#4)", () => {
  it("passes maxSensitivity to engram.search when provided", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await searchRelated.handler(
      searchRelated.inputSchema.parse({
        query: "test query",
        maxSensitivity: "internal",
      }),
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.maxSensitivity).toBe("internal");
  });

  it("omits maxSensitivity from engram.search when not provided (default)", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await searchRelated.handler(
      searchRelated.inputSchema.parse({ query: "test query" }),
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.maxSensitivity).toBeUndefined();
  });
});

describe("search_related — minTrust forwarding (#3)", () => {
  it("passes minTrust to engram.search when provided", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await searchRelated.handler(
      searchRelated.inputSchema.parse({
        query: "test query",
        minTrust: "approved",
      }),
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.minTrust).toBe("approved");
  });

  it("omits minTrust from engram.search when not provided (default, soft down-rank)", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await searchRelated.handler(
      searchRelated.inputSchema.parse({ query: "test query" }),
      ctx,
    );
    expect(captured).toHaveLength(1);
    // minTrust absent → default soft-rank behavior in the SQL layer
    expect(captured[0]!.minTrust).toBeUndefined();
  });
});

// ── kb_search forwarding ──────────────────────────────────────────────────────

describe("kb_search — maxSensitivity forwarding (#4)", () => {
  it("passes maxSensitivity through to engram.search", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await kbSearch.handler(
      kbSearch.inputSchema.parse({
        query: "test",
        maxSensitivity: "confidential",
      }),
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.maxSensitivity).toBe("confidential");
  });

  it("omits maxSensitivity when not provided (no filter applied)", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await kbSearch.handler(kbSearch.inputSchema.parse({ query: "test" }), ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.maxSensitivity).toBeUndefined();
  });

  it("passes minTrust=approved through to engram.search", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await kbSearch.handler(
      kbSearch.inputSchema.parse({ query: "test", minTrust: "approved" }),
      ctx,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.minTrust).toBe("approved");
  });

  it("omits minTrust when not provided (soft down-rank default)", async () => {
    const captured: EngramSearchArgs[] = [];
    const engram: EngramClient = {
      ...fakeEngram([]),
      async search(args) {
        captured.push(args);
        return [];
      },
    };
    const ctx = makeCtx(engram);
    await kbSearch.handler(kbSearch.inputSchema.parse({ query: "test" }), ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.minTrust).toBeUndefined();
  });
});

// ── kb_search Zod schema validation ──────────────────────────────────────────

describe("kb_search — input schema validation", () => {
  it("accepts valid maxSensitivity values", () => {
    for (const v of ["public", "internal", "confidential", "restricted"]) {
      expect(() =>
        kbSearch.inputSchema.parse({ query: "x", maxSensitivity: v }),
      ).not.toThrow();
    }
  });

  it("rejects invalid maxSensitivity", () => {
    expect(() =>
      kbSearch.inputSchema.parse({ query: "x", maxSensitivity: "secret" }),
    ).toThrow();
  });

  it("accepts valid minTrust values", () => {
    for (const v of ["external", "experimental", "approved"]) {
      expect(() =>
        kbSearch.inputSchema.parse({ query: "x", minTrust: v }),
      ).not.toThrow();
    }
  });

  it("rejects invalid minTrust", () => {
    expect(() =>
      kbSearch.inputSchema.parse({ query: "x", minTrust: "unknown" }),
    ).toThrow();
  });

  it("both params are optional (no filter = current default behavior)", () => {
    expect(() =>
      kbSearch.inputSchema.parse({ query: "x" }),
    ).not.toThrow();
  });
});

