import { describe, expect, it } from "vitest";
import {
  buildBackfillReport,
  parseBackfillArgs,
} from "../src/cli/backfill.js";
import type { EngramMemory } from "../src/clients/engram.js";

function memory(id: string, tags: string[], extras: Partial<EngramMemory> = {}): EngramMemory {
  return {
    id,
    content: extras.content ?? `content for ${id}`,
    tags,
    ...(extras.metadata ? { metadata: extras.metadata } : {}),
    ...(extras.createdAt ? { createdAt: extras.createdAt } : {}),
    ...(extras.type ? { type: extras.type } : {}),
  };
}

function fakeEngram(rows: EngramMemory[]) {
  return {
    async search() {
      return rows;
    },
  };
}

describe("parseBackfillArgs", () => {
  it("requires the workspace subcommand", () => {
    const r = parseBackfillArgs([]);
    expect(r).toHaveProperty("error");
  });

  it("requires --slug", () => {
    const r = parseBackfillArgs(["workspace"]);
    expect(r).toEqual(expect.objectContaining({ error: expect.stringContaining("--slug") }));
  });

  it("parses --slug, --dry-run, --limit, --query", () => {
    const r = parseBackfillArgs([
      "workspace",
      "--slug=work",
      "--dry-run",
      "--limit=42",
      "--query=meeting",
    ]);
    expect(r).toEqual({
      slug: "work",
      dryRun: true,
      limit: 42,
      searchQuery: "meeting",
    });
  });

  it("rejects an invalid --limit", () => {
    expect(parseBackfillArgs(["workspace", "--slug=w", "--limit=abc"])).toHaveProperty("error");
    expect(parseBackfillArgs(["workspace", "--slug=w", "--limit=-1"])).toHaveProperty("error");
  });

  it("rejects unknown flags", () => {
    expect(parseBackfillArgs(["workspace", "--slug=w", "--bogus"])).toEqual(
      expect.objectContaining({ error: expect.stringContaining("unknown flag") }),
    );
  });
});

describe("buildBackfillReport", () => {
  it("counts unstamped, matching-slug, and different-slug separately", async () => {
    const rows = [
      memory("u1", []),
      memory("u2", ["owner:matt"]), // tags but no workspace:*
      memory("w1", ["workspace:work"]),
      memory("w2", ["workspace:work", "owner:matt"]),
      memory("o1", ["workspace:side-project"]),
    ];
    const report = await buildBackfillReport(fakeEngram(rows), { slug: "work", limit: 100 });
    expect(report.totalScanned).toBe(5);
    expect(report.unstamped).toBe(2);
    expect(report.alreadyStamped.matchesSlug).toBe(2);
    expect(report.alreadyStamped.differentSlug).toBe(1);
  });

  it("returns up to 5 unstamped rows in sample, with preview/date/project", async () => {
    const rows = [
      memory("a", [], { metadata: { date: "2026-04-01", project: "alpha" } }),
      memory("b", [], { metadata: { project: "beta" }, createdAt: "2026-04-02" }),
      memory("c", []),
      memory("d", []),
      memory("e", []),
      memory("f", []), // 6th — should not appear in sample
    ];
    const report = await buildBackfillReport(fakeEngram(rows), { slug: "work", limit: 100 });
    expect(report.sample.length).toBe(5);
    expect(report.sample[0]).toEqual(
      expect.objectContaining({ id: "a", date: "2026-04-01", project: "alpha" }),
    );
    expect(report.sample[1]).toEqual(
      expect.objectContaining({ id: "b", date: "2026-04-02", project: "beta" }),
    );
    expect(report.sample.find((r) => r.id === "f")).toBeUndefined();
  });

  it("forwards limit + query to engram.search", async () => {
    const calls: Array<{ query: string; limit?: number }> = [];
    const engram = {
      async search(args: { query: string; limit?: number }) {
        calls.push(args);
        return [];
      },
    };
    await buildBackfillReport(engram, { slug: "work", limit: 50, query: "weekly review" });
    expect(calls).toEqual([{ query: "weekly review", limit: 50 }]);
  });

  it("defaults query to '*' when not provided", async () => {
    const calls: Array<{ query: string }> = [];
    const engram = {
      async search(args: { query: string; limit?: number }) {
        calls.push(args);
        return [];
      },
    };
    await buildBackfillReport(engram, { slug: "work", limit: 100 });
    expect(calls[0]!.query).toBe("*");
  });

  it("preview truncates content over 120 chars with ellipsis", async () => {
    const long = "x".repeat(200);
    const rows = [memory("a", [], { content: long })];
    const report = await buildBackfillReport(fakeEngram(rows), { slug: "work", limit: 10 });
    expect(report.sample[0]!.preview.length).toBeLessThanOrEqual(120);
    expect(report.sample[0]!.preview.endsWith("…")).toBe(true);
  });
});
