import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PipelineContext } from "@onenomad/przm-cortex-pipeline-core";
import { createCodeDossierPipeline } from "../src/pipeline.js";
import type { CodeDossierInput } from "../src/types.js";

const FIXTURE_REPO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fixture-repo",
);

const SAMPLE_SYNTHESIS = `# Widgetron architectural dossier

## Purpose & positioning
Widgetron is a library that converts widget strings into v2 wodgets.

## Architecture
\`\`\`
input string -> parse -> Widget -> convert -> Wodget
\`\`\`

## Key modules / packages
- **parse** — string to Widget.
- **convert** — Widget to v2 Wodget.

## Public API surface
- \`convertWidgetString(input: string): Wodget\`
- \`parse\`, \`convert\` (lower-level)

## Notable design decisions
ADR-001 fixes Widgetron on the v2 wodget dialect only.

## Tech stack
- TypeScript

## Glossary
- **Widget** — input shape.
- **Wodget** — output shape.
`;

const SAMPLE_BRIEF = SAMPLE_SYNTHESIS.replace(
  "## Purpose & positioning\nWidgetron is a library",
  "## Purpose & positioning\nWidgetron is a small library",
);

interface MockCtx extends PipelineContext {
  readonly complete: ReturnType<typeof vi.fn>;
}

function makeCtx(llmSequence: string[]): MockCtx {
  const complete = vi
    .fn()
    .mockImplementation(async (_args: { task: string; prompt: string }) => {
      const next = llmSequence.shift();
      if (next === undefined) {
        throw new Error("test stub: ran out of LLM responses");
      }
      return next;
    });
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

function makeCtxNoLlm(): MockCtx {
  const complete = vi.fn();
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    signal: new AbortController().signal,
    complete,
  };
}

const FIXTURE_INPUT: CodeDossierInput = {
  repoPath: FIXTURE_REPO,
  sourceIdPrefix: "github:OneNomad-LLC/widgetron",
  project: "widgetron",
  tags: ["dossier"],
  sourceUrl: "https://github.com/OneNomad-LLC/widgetron",
};

describe("createCodeDossierPipeline", () => {
  it("emits 1 brief + 1 decision + 1 reference for the fixture repo (LLM path)", async () => {
    const ctx = makeCtx([SAMPLE_SYNTHESIS, SAMPLE_BRIEF]);
    const pipeline = createCodeDossierPipeline();

    const memories = await pipeline.run(FIXTURE_INPUT, ctx);

    // 1 brief + 1 ADR + 1 entry point.
    expect(memories).toHaveLength(3);

    const byType: Record<string, number> = {};
    for (const m of memories) {
      const t = m.metadata.type;
      byType[t] = (byType[t] ?? 0) + 1;
    }
    expect(byType).toEqual({
      brief: 1,
      decision: 1,
      reference: 1,
    });

    // LLM called with the right task labels in the right order.
    const tasks = ctx.complete.mock.calls.map((c) => c[0].task);
    expect(tasks).toEqual(["synthesis", "brief"]);
  });

  it("memory shapes match the contract (source, source_id pattern, project, tags, urls)", async () => {
    const ctx = makeCtx([SAMPLE_SYNTHESIS, SAMPLE_BRIEF]);
    const pipeline = createCodeDossierPipeline();
    const memories = await pipeline.run(FIXTURE_INPUT, ctx);

    const brief = memories.find((m) => m.metadata.type === "brief");
    const decision = memories.find((m) => m.metadata.type === "decision");
    const reference = memories.find((m) => m.metadata.type === "reference");

    expect(brief).toBeDefined();
    expect(decision).toBeDefined();
    expect(reference).toBeDefined();

    // All memories carry shared invariants.
    for (const m of memories) {
      expect(m.metadata.domain).toBe("work");
      expect(m.metadata.source).toBe("github");
      expect(m.metadata.source_url).toBe(
        "https://github.com/OneNomad-LLC/widgetron",
      );
      expect(m.metadata.project).toBe("widgetron");
      // Caller's tags plus pipeline-injected role tags.
      expect(m.metadata.tags).toContain("dossier");
      expect(m.metadata.confidence).toBe(0.9);
      expect(typeof m.metadata.date).toBe("string");
    }

    // Deterministic source_ids.
    expect(brief!.metadata.source_id).toBe(
      "github:OneNomad-LLC/widgetron:dossier",
    );
    expect(decision!.metadata.source_id).toBe(
      "github:OneNomad-LLC/widgetron:adr:ADR-001.md",
    );
    expect(reference!.metadata.source_id).toBe(
      "github:OneNomad-LLC/widgetron:api:src/index.ts",
    );

    // Brief content is the polished dossier (Pass 3 output).
    expect(brief!.content).toContain("Widgetron is a small library");
    expect(brief!.metadata.title).toBe("widgetron architectural dossier");

    // ADR memory holds the verbatim ADR body and a useful title.
    expect(decision!.content).toContain("Pick one wodget dialect");
    expect(decision!.metadata.title).toContain("ADR-001");

    // Reference memory wraps the entry point with a header.
    expect(reference!.content).toContain("Public API surface for");
    expect(reference!.content).toContain("export function convertWidgetString");
    expect(reference!.metadata.title).toBe("Public API: src/index.ts");
  });

  it("source_ids are deterministic across runs", async () => {
    const ctxA = makeCtx([SAMPLE_SYNTHESIS, SAMPLE_BRIEF]);
    const ctxB = makeCtx([SAMPLE_SYNTHESIS, SAMPLE_BRIEF]);
    const pipeline = createCodeDossierPipeline();

    const a = await pipeline.run(FIXTURE_INPUT, ctxA);
    const b = await pipeline.run(FIXTURE_INPUT, ctxB);

    const idsA = a.map((m) => m.metadata.source_id).sort();
    const idsB = b.map((m) => m.metadata.source_id).sort();
    expect(idsA).toEqual(idsB);
  });

  it("graceful-degrades to a single brief memory when no LLM is available", async () => {
    const ctx = makeCtxNoLlm();
    const pipeline = createCodeDossierPipeline();

    const memories = await pipeline.run(FIXTURE_INPUT, ctx);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.metadata.type).toBe("brief");
    // The brief content is the raw structural render — should at least
    // contain the README and ARCHITECTURE we fed in.
    expect(memories[0]!.content).toContain("# widgetron architectural dossier");
    // README body verbatim:
    expect(memories[0]!.content).toContain(
      "A small library that turns widgets into wodgets",
    );
    // ARCHITECTURE.md heading verbatim:
    expect(memories[0]!.content).toContain("# Widgetron architecture");
    // No LLM => no ADR or reference memories.
    expect(ctx.complete).not.toHaveBeenCalled();
  });

  it("falls back to manual source type for an unknown source-id prefix", async () => {
    const ctx = makeCtx([SAMPLE_SYNTHESIS, SAMPLE_BRIEF]);
    const pipeline = createCodeDossierPipeline();
    const input: CodeDossierInput = {
      repoPath: FIXTURE_REPO,
      sourceIdPrefix: "local:somerepo",
      project: "widgetron",
      // intentionally no sourceUrl — we want the synthetic fallback.
    };
    const memories = await pipeline.run(input, ctx);
    for (const m of memories) {
      expect(m.metadata.source).toBe("manual");
      expect(m.metadata.source_url).toMatch(/^https:\/\/repo\.local\//);
    }
  });

  it("strips conversational preambles from LLM output", async () => {
    const verbose =
      "Here is the polished dossier:\n\n" + SAMPLE_BRIEF + "\n\nLet me know!";
    const ctx = makeCtx([SAMPLE_SYNTHESIS, verbose]);
    const pipeline = createCodeDossierPipeline();
    const memories = await pipeline.run(FIXTURE_INPUT, ctx);
    const brief = memories.find((m) => m.metadata.type === "brief");
    expect(brief!.content.startsWith("# Widgetron architectural dossier")).toBe(
      true,
    );
  });

  it("degrades gracefully when an LLM pass throws", async () => {
    const ctx = makeCtxNoLlm();
    // Override: present `llm` but make it throw.
    (ctx as PipelineContext).llm = {
      complete: vi
        .fn()
        .mockRejectedValue(new Error("model unavailable")),
    };
    const pipeline = createCodeDossierPipeline();
    const memories = await pipeline.run(FIXTURE_INPUT, ctx);
    // Falls back to single-brief mode; no decision/reference memories.
    expect(memories).toHaveLength(1);
    expect(memories[0]!.metadata.type).toBe("brief");
  });
});
