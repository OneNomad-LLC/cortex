import { describe, expect, it, vi } from "vitest";
import type { ClassifiedItem } from "@onenomad/przm-cortex-core";
import type { PipelineContext } from "@onenomad/przm-cortex-pipeline-core";
import { createConversationPipeline } from "../src/pipeline.js";

function makeItem(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    sourceId: "slack:thread:T1/C1/123",
    sourceType: "slack",
    sourceUrl: "https://yourco.slack.com/archives/C1/p123",
    title: "Alpha channel thread",
    content: [
      "Alex: opening",
      "Sarah: thoughts on the cutover",
      "Alex: let's do a hard flip",
    ].join("\n"),
    contentType: "conversation",
    createdAt: new Date("2026-04-22T12:00:00.000Z"),
    updatedAt: new Date("2026-04-22T13:00:00.000Z"),
    authors: ["alex", "sarah"],
    rawMetadata: {},
    projects: ["project-alpha"],
    confidence: 0.9,
    classificationMethod: "rule",
    ...overrides,
  };
}

function makeCtx(): PipelineContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
    llm: { complete: vi.fn() },
  };
}

describe("createConversationPipeline", () => {
  it("always emits one thread-level memory", async () => {
    const pipeline = createConversationPipeline();
    const mems = await pipeline.run(makeItem(), makeCtx());
    expect(mems).toHaveLength(1);
    expect(mems[0]?.metadata.type).toBe("conversation");
    expect(mems[0]?.metadata.source_id).toBe(
      "slack:thread:T1/C1/123#thread",
    );
    expect(mems[0]?.content).toContain("Alex: opening");
  });

  it("emits quote memories once the thread exceeds the threshold", async () => {
    const pipeline = createConversationPipeline({
      quoteEmitThreshold: 3,
      maxQuotes: 2,
    });
    const content = [
      "Alex: this is a somewhat long opening statement about the plan",
      "Sarah: short reply",
      "Alex: medium length response",
      "Sarah: another longer reflection about tradeoffs and risk",
    ].join("\n");
    const mems = await pipeline.run(makeItem({ content }), makeCtx());
    const types = mems.map((m) => m.metadata.type);
    expect(types).toContain("conversation");
    expect(types.filter((t) => t === "note")).toHaveLength(2);
  });

  it("emits per-day memories when the thread spans many days", async () => {
    const pipeline = createConversationPipeline({
      multiDaySplitThreshold: 1,
    });
    const content = [
      "[2026-04-20T12:00:00Z] Alex: day 1 msg",
      "[2026-04-21T12:00:00Z] Sarah: day 2 msg",
      "[2026-04-22T12:00:00Z] Alex: day 3 msg",
    ].join("\n");
    const mems = await pipeline.run(makeItem({ content }), makeCtx());
    // One thread memory + one per day = 4.
    expect(mems.length).toBe(4);
    const ids = mems.map((m) => m.metadata.source_id);
    expect(ids.filter((id) => id.endsWith("#thread"))).toHaveLength(1);
    expect(ids.filter((id) => id.includes("#day-"))).toHaveLength(3);
  });

  it("returns empty memory list for empty content", async () => {
    const pipeline = createConversationPipeline();
    const mems = await pipeline.run(makeItem({ content: "   \n   " }), makeCtx());
    expect(mems).toHaveLength(0);
  });
});
