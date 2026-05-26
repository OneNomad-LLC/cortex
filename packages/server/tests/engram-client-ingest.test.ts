import { describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildClient } from "../src/clients/engram.js";
import type { McpSubprocess } from "../src/clients/mcp-subprocess.js";

/**
 * Engram's memory_ingest returns `{ ingested: 0, duplicate: true, similar }`
 * when the 0.75-similarity dedupe check rejects a write. Cortex's client
 * MUST surface that as a thrown error — pre-fix, it silently returned
 * `{ id: "" }` and callers (ingest_content) reported fake success, which
 * in turn left my_action_items empty.
 *
 * These tests pin down that contract with a scripted subprocess so future
 * refactors can't silently regress.
 */

type Scripted = {
  name: string;
  args: Record<string, unknown>;
  respond: () => unknown;
};

function fakeSubprocess(script: Scripted[]): {
  sub: McpSubprocess;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let i = 0;
  const client = {
    async callTool(
      req: { name: string; arguments: Record<string, unknown> },
    ): Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }> {
      calls.push({ name: req.name, args: req.arguments });
      const step = script[i++];
      if (!step) {
        throw new Error(`fake subprocess: no scripted response for ${req.name}`);
      }
      if (step.name !== req.name) {
        throw new Error(
          `fake subprocess: expected ${step.name}, got ${req.name}`,
        );
      }
      const payload = step.respond();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
    async close() {},
  } as unknown as Client;

  const sub: McpSubprocess = {
    client,
    async close() {},
  };
  return { sub, calls };
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silentLogger;
  },
} as unknown as Parameters<typeof buildClient>[1];

describe("engram client — ingest", () => {
  it("returns { id } on a successful write", async () => {
    const { sub } = fakeSubprocess([
      {
        name: "memory_ingest",
        args: {},
        respond: () => ({
          ingested: 1,
          memory: { id: "abc-123" },
        }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    const res = await client.ingest({
      content: "note body",
      metadata: { type: "note", project: "driven-brands", domain: "work" },
    });
    expect(res).toEqual({ id: "abc-123" });
  });

  it("throws when engram returns ingested=0 with duplicate=true", async () => {
    const { sub } = fakeSubprocess([
      {
        name: "memory_ingest",
        args: {},
        respond: () => ({
          ingested: 0,
          duplicate: true,
          similar: [
            { id: "prior-xyz", content: "earlier note", score: 0.82 },
          ],
        }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    await expect(
      client.ingest({
        content: "refinement of an earlier note",
        metadata: { type: "action_item", project: "driven-brands" },
      }),
    ).rejects.toThrow(/engram rejected ingest.*duplicate.*prior-xyz/);
  });

  it("throws when engram returns ingested=0 with no duplicate flag", async () => {
    const { sub } = fakeSubprocess([
      {
        name: "memory_ingest",
        args: {},
        respond: () => ({ ingested: 0 }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    await expect(
      client.ingest({
        content: "x",
        metadata: { type: "doc", project: "driven-brands" },
      }),
    ).rejects.toThrow(/engram rejected ingest.*ingested=0/);
  });

  it("flattens metadata into engram's flat schema + tags", async () => {
    const { sub, calls } = fakeSubprocess([
      {
        name: "memory_ingest",
        args: {},
        respond: () => ({ ingested: 1, memory: { id: "id-1" } }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    await client.ingest({
      content: "Ping Brandon about legacy",
      metadata: {
        type: "action_item",
        project: "legacy",
        workspace: "acmeco",
        source: "slack",
        source_id: "action-2026-04-24-brandon",
        domain: "work",
        tags: ["owner:alice", "due:2026-04-24"],
      },
    });
    // engram's schema is flat — no nested `metadata` object.
    const sent = calls[0].args;
    expect(sent).not.toHaveProperty("metadata");
    expect(sent.content).toBe("Ping Brandon about legacy");
    expect(sent.type).toBe("context"); // action_item → engram "context"
    expect(sent.domain).toBe("work");
    expect(sent.topic).toBe("legacy");
    expect(sent.source).toBe("action-2026-04-24-brandon");
    expect(sent.skipDedupe).toBe(true); // structured type
    const tags = (sent.tags as string).split(",");
    expect(tags).toContain("cortex_type:action_item");
    expect(tags).toContain("project:legacy");
    expect(tags).toContain("workspace:acmeco");
    expect(tags).toContain("source:slack");
    expect(tags).toContain("source_id:action-2026-04-24-brandon");
    expect(tags).toContain("owner:alice");
    expect(tags).toContain("due:2026-04-24");
  });

  it("does NOT skip dedupe for doc/code types", async () => {
    const { sub, calls } = fakeSubprocess([
      {
        name: "memory_ingest",
        args: {},
        respond: () => ({ ingested: 1, memory: { id: "id-1" } }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    await client.ingest({
      content: "doc body",
      metadata: { type: "doc", project: "legacy" },
    });
    expect(calls[0].args.skipDedupe).toBeUndefined();
  });

  it("maps decision type to engram's native 'decision'", async () => {
    const { sub, calls } = fakeSubprocess([
      {
        name: "memory_ingest",
        args: {},
        respond: () => ({ ingested: 1, memory: { id: "id-1" } }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    await client.ingest({
      content: "decision body",
      metadata: { type: "decision", project: "legacy" },
    });
    expect(calls[0].args.type).toBe("decision");
  });
});

describe("engram client — search", () => {
  it("translates args.type into a cortex_type tag filter", async () => {
    const { sub, calls } = fakeSubprocess([
      {
        name: "memory_search",
        args: {},
        respond: () => ({ results: [] }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    await client.search({
      query: "anything",
      type: "action_item",
      domain: "work",
    });
    expect(calls[0].args.tag).toBe("cortex_type:action_item");
    expect(calls[0].args).not.toHaveProperty("filters");
  });

  it("assembles metadata shim on returned rows", async () => {
    const { sub } = fakeSubprocess([
      {
        name: "memory_search",
        args: {},
        respond: () => ({
          results: [
            {
              id: "m1",
              content: "Ping Brandon",
              type: "context",
              domain: "work",
              topic: "legacy",
              source: "action-brandon-legacy-help",
              tags: [
                "cortex_type:action_item",
                "workspace:acmeco",
                "owner:alice",
                "due:2026-04-24",
              ],
              score: 0.92,
            },
          ],
        }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    const rows = await client.search({
      query: "brandon",
      type: "action_item",
      domain: "work",
      workspace: "acmeco",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe("m1");
    expect(row.tags).toContain("owner:alice");
    expect(row.tags).toContain("due:2026-04-24");
    // Shim for downstream code that reads meta.tags / meta.source
    const meta = row.metadata ?? {};
    expect(meta.tags).toEqual(row.tags);
    expect(meta.source).toBe("action-brandon-legacy-help");
    expect(meta.domain).toBe("work");
  });

  it("drops rows whose workspace tag doesn't match the filter", async () => {
    const { sub } = fakeSubprocess([
      {
        name: "memory_search",
        args: {},
        respond: () => ({
          results: [
            {
              id: "match",
              content: "a",
              tags: ["cortex_type:action_item", "workspace:acmeco"],
            },
            {
              id: "miss",
              content: "b",
              tags: ["cortex_type:action_item", "workspace:onenomad"],
            },
            {
              id: "legacy",
              content: "c",
              tags: ["cortex_type:action_item"],
            },
          ],
        }),
      },
    ]);
    const client = buildClient(sub, silentLogger);
    const rows = await client.search({
      query: "q",
      type: "action_item",
      workspace: "acmeco",
    });
    // Keep match + legacy (no workspace tag), drop miss.
    expect(rows.map((r) => r.id)).toEqual(["match", "legacy"]);
  });
});
