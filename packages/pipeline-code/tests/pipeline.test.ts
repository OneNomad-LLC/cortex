import { describe, expect, it, vi } from "vitest";
import type { ClassifiedItem } from "@onenomad/przm-cortex-core";
import type { PipelineContext } from "@onenomad/przm-cortex-pipeline-core";
import { createCodePipeline } from "../src/pipeline.js";

function makeItem(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    sourceId: "github:yourco/cortex@abc/src/foo.ts",
    sourceType: "github",
    sourceUrl: "https://github.com/yourco/cortex/blob/main/src/foo.ts",
    title: "src/foo.ts",
    content: "export function hello() {\n  return 1;\n}\n",
    contentType: "code",
    createdAt: new Date("2026-04-22T00:00:00.000Z"),
    updatedAt: new Date("2026-04-22T00:00:00.000Z"),
    authors: [],
    rawMetadata: { filePath: "src/foo.ts", repo: "yourco/cortex" },
    projects: ["engineering"],
    confidence: 0.95,
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

describe("createCodePipeline", () => {
  it("emits one memory per chunk with language tags and type=code", async () => {
    const pipeline = createCodePipeline({ maxChunkChars: 10_000 });
    const mems = await pipeline.run(makeItem(), makeCtx());
    expect(mems).toHaveLength(1);
    expect(mems[0]?.metadata.type).toBe("code");
    expect(mems[0]?.metadata.tags).toContain("language:typescript");
    expect(mems[0]?.metadata.title).toBe("src/foo.ts");
  });

  it("emits markdown files with type=doc", async () => {
    const pipeline = createCodePipeline({ maxChunkChars: 10_000 });
    const mems = await pipeline.run(
      makeItem({
        rawMetadata: { filePath: "README.md" },
        title: "README.md",
        content: "# Hello\n\nSome prose.",
      }),
      makeCtx(),
    );
    expect(mems[0]?.metadata.type).toBe("doc");
    expect(mems[0]?.metadata.tags).toContain("language:markdown");
  });

  it("skips files above the byte cap", async () => {
    const pipeline = createCodePipeline({ maxFileBytes: 16 });
    const mems = await pipeline.run(
      makeItem({ content: "const x = 1;\nconst y = 2;\nconst z = 3;" }),
      makeCtx(),
    );
    expect(mems).toHaveLength(0);
  });

  it("uses symbol names in chunk titles when boundary detection finds them", async () => {
    const src = [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return 2;",
      "}",
    ].join("\n");
    const pipeline = createCodePipeline({ maxChunkChars: 30 });
    const mems = await pipeline.run(makeItem({ content: src }), makeCtx());
    const titles = mems.map((m) => m.metadata.title);
    expect(titles.some((t) => t?.includes("alpha"))).toBe(true);
    expect(titles.some((t) => t?.includes("beta"))).toBe(true);
  });

  it("numbers parts when a file splits but no symbol is detected", async () => {
    const src = "a\n".repeat(300);
    const pipeline = createCodePipeline({ maxChunkChars: 100 });
    const mems = await pipeline.run(
      makeItem({
        content: src,
        rawMetadata: { filePath: "notes.txt" },
        title: "notes.txt",
      }),
      makeCtx(),
    );
    expect(mems.length).toBeGreaterThan(1);
    expect(mems[0]?.metadata.title).toMatch(/notes\.txt \(\d+\/\d+\)/);
  });
});
