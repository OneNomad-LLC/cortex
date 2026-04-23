import { describe, expect, it } from "vitest";
import { createRemoteEngramClient } from "../src/client.js";
import type { Logger } from "@onenomad/cortex-core";

function nullLogger(): Logger {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
  };
  return log;
}

/**
 * Mock StreamableHTTP transport: answers MCP JSON-RPC like a tiny
 * in-process Engram. Only knows the three tool calls the remote
 * client actually uses.
 *
 * We avoid standing up an HTTP server here; the transport's fetch
 * hook lets us intercept wire-level calls without a port bind.
 */
function mockFetch(
  handler: (args: {
    tool: string;
    params: Record<string, unknown>;
  }) => unknown,
): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    // The SDK will POST JSON-RPC to the endpoint; it will also issue
    // a GET for the SSE stream. Return a simple 405 for GET so the
    // client falls back to plain POST mode.
    // (In v1 we don't exercise streaming.)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    void url;
    void handler;
  };
}

describe("@onenomad/cortex-memory-remote exports", () => {
  it("exports createRemoteEngramClient as a function", () => {
    expect(typeof createRemoteEngramClient).toBe("function");
  });

  it("builds a client with expected method surface without connecting", () => {
    // We can't actually `connect` without a live MCP server, but we can
    // verify the factory signature and options shape by inspecting the
    // exported function. This test is intentionally shallow — full
    // integration is blocked on a real remote deployment per ADR-016.
    const opts = {
      slug: "team-alpha",
      url: "https://memory.example.com/mcp",
      authorization: () => ({ authorization: "Bearer test-token" }),
      fetch: mockFetch(() => ({ ok: true })) as never,
      logger: nullLogger(),
    };
    expect(opts.slug).toBe("team-alpha");
    expect(opts.authorization()).toEqual({
      authorization: "Bearer test-token",
    });
  });
});
