import { describe, expect, it, vi } from "vitest";
import type { ClassifiedItem } from "@onenomad/cortex-core";
import type { PipelineContext } from "@onenomad/cortex-pipeline-core";
import { createDocPipeline } from "../src/pipeline.js";

function makeItem(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  const now = new Date("2026-04-21T12:00:00.000Z");
  return {
    sourceId: "confluence:page:123",
    sourceType: "confluence",
    sourceUrl: "https://example.atlassian.net/wiki/pages/123",
    title: "Test Doc",
    content: "# Section One\n\nbody of one\n\n## Sub A\n\nbody of sub a\n",
    contentType: "doc",
    createdAt: now,
    updatedAt: now,
    authors: [],
    rawMetadata: {},
    projects: ["engineering"],
    confidence: 0.95,
    classificationMethod: "rule",
    ...overrides,
  };
}

function makeCtx(): PipelineContext {
  const noop = vi.fn();
  return {
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    },
    llm: { complete: vi.fn() },
    signal: new AbortController().signal,
  };
}

describe("createDocPipeline", () => {
  it("emits one memory per chunk with heading-path titles", async () => {
    const pipeline = createDocPipeline({ minChunkChars: 0 });
    const mems = await pipeline.run(makeItem(), makeCtx());

    expect(mems).toHaveLength(2);
    expect(mems[0]?.metadata.title).toBe("Section One");
    expect(mems[1]?.metadata.title).toBe("Section One > Sub A");
    expect(mems[0]?.content).toContain("body of one");
    expect(mems[1]?.content).toContain("body of sub a");
  });

  it("carries the source metadata contract on each chunk", async () => {
    const pipeline = createDocPipeline({ minChunkChars: 0 });
    const mems = await pipeline.run(makeItem(), makeCtx());
    expect(mems[0]?.metadata).toMatchObject({
      domain: "work",
      source: "confluence",
      project: "engineering",
      type: "doc",
      confidence: 0.95,
    });
    expect(mems[0]?.metadata.source_id).toBe("confluence:page:123#chunk-0");
    expect(mems[1]?.metadata.source_id).toBe("confluence:page:123#chunk-1");
  });

  it("merges chunks shorter than minChunkChars into the next one", async () => {
    const short = "# Short\n\nhi\n\n## Next\n\nmuch longer body here indeed";
    const pipeline = createDocPipeline({ minChunkChars: 40 });
    const mems = await pipeline.run(makeItem({ content: short }), makeCtx());
    expect(mems).toHaveLength(1);
    expect(mems[0]?.content).toContain("hi");
    expect(mems[0]?.content).toContain("much longer body here indeed");
  });

  it("represents multi-project classification as an array", async () => {
    const pipeline = createDocPipeline({ minChunkChars: 0 });
    const mems = await pipeline.run(
      makeItem({ projects: ["engineering", "product"] }),
      makeCtx(),
    );
    expect(mems[0]?.metadata.project).toEqual(["engineering", "product"]);
  });

  it("stamps engagement / sub_brand / team from ClassifiedItem when present", async () => {
    const pipeline = createDocPipeline({ minChunkChars: 0 });
    const mems = await pipeline.run(
      makeItem({
        engagement: "acme-corp",
        subBrand: "alpha-retail",
        team: "alpha",
      }),
      makeCtx(),
    );
    expect(mems[0]?.metadata).toMatchObject({
      engagement: "acme-corp",
      sub_brand: "alpha-retail",
      team: "alpha",
    });
  });

  it("omits context fields when ClassifiedItem doesn't carry them (back-compat)", async () => {
    const pipeline = createDocPipeline({ minChunkChars: 0 });
    const mems = await pipeline.run(makeItem(), makeCtx());
    expect(mems[0]?.metadata).not.toHaveProperty("engagement");
    expect(mems[0]?.metadata).not.toHaveProperty("sub_brand");
    expect(mems[0]?.metadata).not.toHaveProperty("team");
    expect(mems[0]?.metadata).not.toHaveProperty("release");
  });
});
