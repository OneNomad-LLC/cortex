import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ClassifiedItem } from "@onenomad/cortex-core";
import type { PipelineContext } from "@onenomad/cortex-pipeline-core";
import {
  createMeetingPipeline,
  parseJsonLoose,
  splitIntoChunks,
} from "../src/pipeline.js";
import type { MeetingStructured } from "../src/types.js";

const fixture = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "alpha-planning.txt",
  ),
  "utf8",
);

const SAMPLE_STRUCTURED: MeetingStructured = {
  summary: "Team locked scope and ownership for Alpha v2.",
  participants: [
    { name: "Alex", role: "Engineering" },
    { name: "Sarah", role: "Engineering lead" },
  ],
  topics: ["Alpha v2 rewrite", "Cutover strategy"],
  decisions: [
    {
      statement: "Alpha v2 ships next Friday.",
      owner: "Sarah",
      rationale: "Scope agreed with product.",
    },
    {
      statement: "Priya leads front-end under Sarah.",
      owner: "Sarah",
      rationale: null,
    },
  ],
  action_items: [
    { description: "Handle DB migration.", owner: "Alex", due_hint: "next Friday" },
    { description: "Book 30 min with Karim.", owner: "Sarah", due_hint: "this week" },
  ],
  key_quotes: [{ speaker: "Alex", text: "Confirmed on next Friday." }],
};

const SAMPLE_SYNTHESIZED: MeetingStructured = {
  ...SAMPLE_STRUCTURED,
  action_items: [
    { description: "Handle DB migration.", owner: "Alex", due_hint: "next Friday", due_date: "2026-05-01" },
    { description: "Book 30 min with Karim about cutover.", owner: "Sarah", due_hint: "this week", due_date: null },
  ],
};

const SAMPLE_BRIEF = [
  "# Alpha v2 planning",
  "",
  "_2026-04-22 · Alex, Sarah_",
  "",
  "## TL;DR",
  "- Alpha v2 ships next Friday",
  "- Priya leads front-end under Sarah",
  "",
  "## Decisions",
  "- **Sarah:** Alpha v2 ships next Friday.",
  "- **Sarah:** Priya leads front-end.",
  "",
  "## Action items",
  "- [ ] **Alex:** Handle DB migration. _(due 2026-05-01)_",
  "- [ ] **Sarah:** Book 30 min with Karim about cutover.",
  "",
  "## Discussion",
  "- Agreed scope for the billing rewrite.",
  "",
  "## Open threads",
  "- Hard cutover vs legacy endpoints — pending Karim.",
].join("\n");

function makeItem(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    sourceId: "loom:rec:xyz",
    sourceType: "loom",
    sourceUrl: "https://loom.com/share/xyz",
    title: "Alpha v2 planning",
    content: fixture,
    contentType: "meeting",
    createdAt: new Date("2026-04-22T15:00:00.000Z"),
    updatedAt: new Date("2026-04-22T15:45:00.000Z"),
    authors: ["alex", "sarah"],
    rawMetadata: {},
    projects: ["project-alpha"],
    confidence: 0.95,
    classificationMethod: "attendee-match",
    ...overrides,
  };
}

function makeCtx(
  llmSequence: string[],
): PipelineContext & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn().mockImplementation(
    async (args: { task: string }) => {
      // Signal extractor runs in parallel with pass 1 and consumes an
      // LLM call — dispatch it to an empty stub so it doesn't steal
      // responses intended for structural/synthesis/brief. The
      // pipeline's .catch() swallows the empty shape either way.
      if (args.task === "classify") return "{}";
      const next = llmSequence.shift();
      if (next === undefined) {
        throw new Error("test stub: ran out of LLM responses");
      }
      return next;
    },
  );
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    signal: new AbortController().signal,
    llm: { complete },
    complete,
  };
}

describe("createMeetingPipeline", () => {
  it("runs three LLM passes in the right order and emits brief + decision + action memories", async () => {
    const ctx = makeCtx([
      JSON.stringify(SAMPLE_STRUCTURED),
      JSON.stringify(SAMPLE_SYNTHESIZED),
      SAMPLE_BRIEF,
    ]);

    const pipeline = createMeetingPipeline({
      // Keep the fixture small; disable chunking to simplify assertions.
      chunkSize: 10_000,
    });
    const memories = await pipeline.run(makeItem(), ctx);

    // 1 brief + 2 decisions + 2 action_items + 1 chunk = 6
    expect(memories).toHaveLength(6);

    const byType: Record<string, number> = {};
    for (const m of memories) {
      const t = m.metadata.type as string;
      byType[t] = (byType[t] ?? 0) + 1;
    }
    expect(byType).toEqual({
      brief: 1,
      decision: 2,
      action_item: 2,
      meeting: 1,
    });

    // All memories share the adapter's source_id root.
    for (const m of memories) {
      expect(m.metadata.source_id).toMatch(/^loom:rec:xyz#/);
    }

    // LLM called with the right task labels. The signal extractor
    // runs in parallel with pass 1 under task="classify"; filter it
    // out so the assertion stays focused on the three extraction passes.
    const extractionTasks = ctx.complete.mock.calls
      .map((c) => c[0].task)
      .filter((t: string) => t !== "classify");
    expect(extractionTasks).toEqual(["structural", "synthesis", "brief"]);
  });

  it("respects toggles that drop decision / action_item / chunk outputs", async () => {
    const ctx = makeCtx([
      JSON.stringify(SAMPLE_STRUCTURED),
      JSON.stringify(SAMPLE_SYNTHESIZED),
      SAMPLE_BRIEF,
    ]);
    const pipeline = createMeetingPipeline({
      includeDecisionMemories: false,
      includeActionItemMemories: false,
      includeTranscriptChunks: false,
      chunkSize: 10_000,
    });
    const memories = await pipeline.run(makeItem(), ctx);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.metadata.type).toBe("brief");
  });

  it("parses JSON even when the model wraps it in a ```json fence", async () => {
    const ctx = makeCtx([
      "```json\n" + JSON.stringify(SAMPLE_STRUCTURED) + "\n```",
      "```json\n" + JSON.stringify(SAMPLE_SYNTHESIZED) + "\n```",
      SAMPLE_BRIEF,
    ]);
    const pipeline = createMeetingPipeline({ chunkSize: 10_000 });
    const memories = await pipeline.run(makeItem(), ctx);
    expect(memories.length).toBeGreaterThan(0);
  });
});

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}').a).toBe(1);
  });
  it("strips ```json fences", () => {
    expect(
      parseJsonLoose<{ a: number }>('```json\n{"a":2}\n```').a,
    ).toBe(2);
  });
  it("extracts the first JSON object from prose-wrapped output", () => {
    expect(
      parseJsonLoose<{ ok: boolean }>('here you go: {"ok": true} thanks').ok,
    ).toBe(true);
  });
  it("throws on completely non-JSON input", () => {
    expect(() => parseJsonLoose("no json here at all")).toThrow();
  });
});

describe("splitIntoChunks", () => {
  it("returns one chunk when under the limit", () => {
    expect(splitIntoChunks("short text", 1000)).toEqual(["short text"]);
  });

  it("splits on paragraph boundaries", () => {
    const text = "A".repeat(50) + "\n\n" + "B".repeat(50) + "\n\n" + "C".repeat(50);
    const chunks = splitIntoChunks(text, 60);
    // Each paragraph lands in its own chunk since 50+2+50 > 60.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
