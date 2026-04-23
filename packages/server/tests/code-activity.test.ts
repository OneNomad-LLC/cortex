import { describe, expect, it } from "vitest";
import { codeActivityWidget } from "../src/api/widgets/code-activity.js";
import type { WidgetContext } from "../src/api/types.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";
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

function fakeEngram(rows: EngramMemory[]): EngramClient {
  return {
    async ingest() {
      return { id: "x" };
    },
    async search(args) {
      if (!args.type) return rows;
      return rows.filter((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
        return tags.includes(`type:${args.type}`) || r.type === args.type;
      });
    },
    async healthCheck() {
      return { healthy: true, message: "" };
    },
    async shutdown() {
      return;
    },
  };
}

function mockCtx(rows: EngramMemory[]): WidgetContext {
  return {
    logger: nullLogger(),
    engram: fakeEngram(rows),
    llmRouter: {} as never,
    taxonomy: {} as never,
  };
}

describe("code-activity widget", () => {
  it("groups code snapshots by project with language breakdown", async () => {
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const out = await codeActivityWidget.handler(
      new URLSearchParams({ days: "7" }),
      mockCtx([
        {
          id: "c1",
          type: "code",
          content: "export function foo() {}",
          metadata: {
            source: "bitbucket",
            source_url: "https://bitbucket.org/ws/alpha/src/main/foo.ts",
            source_id: "bitbucket:alpha@main:foo.ts",
            title: "alpha/foo.ts",
            project: "alpha",
            date: now,
            tags: ["language:typescript"],
          },
        },
        {
          id: "c2",
          type: "code",
          content: "export const bar = 1",
          metadata: {
            source: "bitbucket",
            source_url: "https://bitbucket.org/ws/alpha/src/main/bar.ts",
            source_id: "bitbucket:alpha@main:bar.ts",
            title: "alpha/bar.ts",
            project: "alpha",
            date: older,
            tags: ["language:typescript"],
          },
        },
        {
          id: "c3",
          type: "code",
          content: "def hello():\n    pass",
          metadata: {
            source: "github",
            source_url: "https://github.example.com/acme/beta/blob/main/hello.py",
            source_id: "github:acme/beta@main:hello.py",
            title: "acme/beta/hello.py",
            project: "beta",
            date: now,
            tags: ["language:python"],
          },
        },
      ]),
    );

    expect(out.total).toBe(3);
    const alpha = out.rows.find((r) => r.project === "alpha");
    const beta = out.rows.find((r) => r.project === "beta");
    expect(alpha?.count).toBe(2);
    expect(alpha?.languages).toEqual([{ language: "typescript", count: 2 }]);
    expect(alpha?.lastFile).toBe("alpha/foo.ts");
    expect(beta?.count).toBe(1);
    expect(beta?.languages).toEqual([{ language: "python", count: 1 }]);
  });

  it("returns a friendly note when there's no activity", async () => {
    const out = await codeActivityWidget.handler(
      new URLSearchParams(),
      mockCtx([]),
    );
    expect(out.rows).toEqual([]);
    expect(out.note).toMatch(/No code snapshots/);
  });

  it("sorts projects by most-recent activity, not by count", async () => {
    const old = new Date(Date.now() - 10 * 3_600_000).toISOString();
    const fresh = new Date(Date.now() - 10 * 60_000).toISOString();

    const out = await codeActivityWidget.handler(
      new URLSearchParams(),
      mockCtx([
        // alpha has MORE files but they're older
        {
          id: "c1",
          type: "code",
          content: "a",
          metadata: { project: "alpha", date: old, tags: ["language:ts"] },
        },
        {
          id: "c2",
          type: "code",
          content: "a",
          metadata: { project: "alpha", date: old, tags: ["language:ts"] },
        },
        {
          id: "c3",
          type: "code",
          content: "a",
          metadata: { project: "alpha", date: old, tags: ["language:ts"] },
        },
        // beta has fewer, but fresher
        {
          id: "c4",
          type: "code",
          content: "a",
          metadata: { project: "beta", date: fresh, tags: ["language:py"] },
        },
      ]),
    );

    expect(out.rows[0]!.project).toBe("beta");
    expect(out.rows[1]!.project).toBe("alpha");
  });
});
