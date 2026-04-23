import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@onenomad/cortex-core";
import { SlackAdapter } from "../src/adapter.js";

function makeCtx(cfg: Record<string, unknown>): AdapterContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return {
    logger,
    config: cfg,
    secrets: { SLACK_BOT_TOKEN: "xoxb-test" },
    signal: new AbortController().signal,
    engram: {
      ingest: vi.fn(async () => ({ id: "fake" })),
      healthCheck: vi.fn(async () => ({ healthy: true, message: "" })),
    },
    taxonomy: {
      listProjects: () => [],
      findProjectBySlug: () => undefined,
      findProject: () => undefined,
      listPeople: () => [],
      findPersonBySlug: () => undefined,
      findPersonByEmail: () => undefined,
      findPerson: () => undefined,
    },
    llm: { raw: null, complete: vi.fn() },
  };
}

describe("SlackAdapter", () => {
  it("transform emits speaker-timestamped lines for pipeline-conversation", async () => {
    const adapter = new SlackAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourco",
        channels: ["C123"],
        channelToProject: { C123: "engineering" },
      }),
    );

    const raw = {
      channel: "C123",
      rootTs: "1713792000.000100",
      messages: [
        {
          ts: "1713792000.000100",
          text: "Kicking off the cutover thread",
          user: "U1",
          displayName: "Alex",
        },
        {
          ts: "1713792060.000200",
          thread_ts: "1713792000.000100",
          text: "I'll handle the migration",
          user: "U2",
          displayName: "Sarah",
        },
      ],
    };

    const normalized = await adapter.transform({
      sourceId: "slack:thread:C123:1713792000.000100",
      raw,
    });

    expect(normalized.sourceType).toBe("slack");
    expect(normalized.contentType).toBe("conversation");
    expect(normalized.title).toContain("cutover");
    expect(normalized.content).toContain("Alex: Kicking off the cutover thread");
    expect(normalized.content).toContain("Sarah: I'll handle the migration");
    expect(normalized.rawMetadata.channel).toBe("C123");
    expect(normalized.rawMetadata.messageCount).toBe(2);
    expect(normalized.authors).toEqual(["Alex", "Sarah"]);
    expect(normalized.sourceUrl).toContain("yourco.slack.com");
  });

  it("classifies via channelToProject", async () => {
    const adapter = new SlackAdapter();
    await adapter.init(
      makeCtx({
        workspace: "yourco",
        channels: ["C123"],
        channelToProject: { C123: "engineering" },
      }),
    );

    const classified = await adapter.classify(
      {
        sourceId: "x",
        sourceType: "slack",
        sourceUrl: "https://x",
        title: "t",
        content: "c",
        contentType: "conversation",
        createdAt: new Date(),
        updatedAt: new Date(),
        authors: [],
        rawMetadata: { channel: "C123" },
      },
      {},
    );
    expect(classified.projects).toEqual(["engineering"]);
  });

  it("init throws without SLACK_BOT_TOKEN", async () => {
    const adapter = new SlackAdapter();
    const ctx = makeCtx({ workspace: "yourco", channels: ["C1"] });
    ctx.secrets = {};
    await expect(adapter.init(ctx)).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });

  it("init throws when channels is empty", async () => {
    const adapter = new SlackAdapter();
    await expect(
      adapter.init(makeCtx({ workspace: "yourco", channels: [] })),
    ).rejects.toThrow(/channels/);
  });
});
