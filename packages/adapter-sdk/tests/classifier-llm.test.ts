import { describe, expect, it, vi } from "vitest";
import type { NormalizedItem, Project, TaxonomyReader } from "@onenomad/przm-cortex-core";
import { LLMClassifier } from "../src/classifier-llm.js";

function fakeTaxonomy(projects: Project[]): TaxonomyReader {
  return {
    listProjects: () => projects.filter((p) => p.active),
    findProjectBySlug: (s) => projects.find((p) => p.slug === s),
    findProject: (q) =>
      projects.find(
        (p) => p.slug === q || p.name === q || p.aliases.includes(q),
      ),
    listPeople: () => [],
    findPersonBySlug: () => undefined,
    findPersonByEmail: () => undefined,
    findPerson: () => undefined,
  };
}

const PROJECTS: Project[] = [
  {
    slug: "project-alpha",
    name: "Project Alpha",
    description: "Billing rewrite",
    active: true,
    aliases: ["Alpha"],
    people: [],
    sources: {},
  },
  {
    slug: "project-beta",
    name: "Project Beta",
    description: "Reporting dashboard",
    active: true,
    aliases: [],
    people: [],
    sources: {},
  },
];

const ITEM: NormalizedItem = {
  sourceId: "x:1",
  sourceType: "notion",
  sourceUrl: "https://example.com",
  title: "Alpha billing notes",
  content: "Decisions about the billing rewrite and the token service.",
  contentType: "doc",
  createdAt: new Date(),
  updatedAt: new Date(),
  authors: [],
  rawMetadata: {},
};

describe("LLMClassifier", () => {
  it("returns model-selected projects when JSON response is valid", async () => {
    const llm = {
      complete: vi
        .fn()
        .mockResolvedValue(
          '{"projects":["project-alpha"],"confidence":0.82,"reason":"billing"}',
        ),
    };
    const c = new LLMClassifier({
      taxonomy: fakeTaxonomy(PROJECTS),
      llm,
    });
    const res = await c.classify(ITEM, {});
    expect(res.projects).toEqual(["project-alpha"]);
    expect(res.confidence).toBeCloseTo(0.82);
    expect(res.classificationMethod).toBe("content-llm");
  });

  it("strips ```json fences from the response", async () => {
    const llm = {
      complete: vi.fn().mockResolvedValue(
        '```json\n{"projects":["project-beta"],"confidence":0.9}\n```',
      ),
    };
    const c = new LLMClassifier({
      taxonomy: fakeTaxonomy(PROJECTS),
      llm,
    });
    const res = await c.classify(ITEM, {});
    expect(res.projects).toEqual(["project-beta"]);
  });

  it("drops unknown project slugs the model invented", async () => {
    const llm = {
      complete: vi
        .fn()
        .mockResolvedValue('{"projects":["made-up"],"confidence":0.9}'),
    };
    const c = new LLMClassifier({
      taxonomy: fakeTaxonomy(PROJECTS),
      llm,
    });
    const res = await c.classify(ITEM, {});
    expect(res.projects).toEqual([]);
  });

  it("returns empty projects below minConfidence", async () => {
    const llm = {
      complete: vi
        .fn()
        .mockResolvedValue('{"projects":["project-alpha"],"confidence":0.2}'),
    };
    const c = new LLMClassifier({
      taxonomy: fakeTaxonomy(PROJECTS),
      llm,
      minConfidence: 0.5,
    });
    const res = await c.classify(ITEM, {});
    expect(res.projects).toEqual([]);
    expect(res.confidence).toBeCloseTo(0.2);
  });

  it("swallows LLM errors and returns unclassified", async () => {
    const llm = {
      complete: vi.fn().mockRejectedValue(new Error("llm down")),
    };
    const c = new LLMClassifier({
      taxonomy: fakeTaxonomy(PROJECTS),
      llm,
    });
    const res = await c.classify(ITEM, {});
    expect(res.projects).toEqual([]);
    expect(res.confidence).toBe(0);
  });

  it("returns unclassified when taxonomy is empty", async () => {
    const llm = { complete: vi.fn() };
    const c = new LLMClassifier({
      taxonomy: fakeTaxonomy([]),
      llm,
    });
    const res = await c.classify(ITEM, {});
    expect(res.projects).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("caps projects at maxProjects even when model returns more", async () => {
    const extra = [
      ...PROJECTS,
      {
        slug: "project-gamma",
        name: "Project Gamma",
        description: "",
        active: true,
        aliases: [],
        people: [],
        sources: {},
      },
      {
        slug: "project-delta",
        name: "Project Delta",
        description: "",
        active: true,
        aliases: [],
        people: [],
        sources: {},
      },
    ];
    const llm = {
      complete: vi
        .fn()
        .mockResolvedValue(
          '{"projects":["project-alpha","project-beta","project-gamma","project-delta"],"confidence":0.8}',
        ),
    };
    const c = new LLMClassifier({
      taxonomy: fakeTaxonomy(extra),
      llm,
      maxProjects: 2,
    });
    const res = await c.classify(ITEM, {});
    expect(res.projects).toHaveLength(2);
  });
});
