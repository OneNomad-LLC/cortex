import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  todayTimelineWidget,
  computeEndOfDayPrompt,
} from "../src/api/widgets/today-timeline.js";
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

function mockCtx(rows: EngramMemory[] = []): WidgetContext {
  return {
    logger: nullLogger(),
    engram: fakeEngram(rows),
    llmRouter: {} as never,
    taxonomy: {
      projects: [],
      people: [],
      findProject: () => undefined,
      findPerson: () => undefined,
    } as never,
  };
}

describe("today-timeline widget", () => {
  let tmpStateDir: string;
  let prevStatePath: string | undefined;

  // Tests run without host workspace state — see api.test.ts for rationale.
  beforeAll(() => {
    tmpStateDir = mkdtempSync(join(tmpdir(), "cortex-tl-test-state-"));
    const stateFile = join(tmpStateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ workspaces: {} }), "utf8");
    prevStatePath = process.env.CORTEX_STATE_PATH;
    process.env.CORTEX_STATE_PATH = stateFile;
  });
  afterAll(() => {
    if (prevStatePath === undefined) delete process.env.CORTEX_STATE_PATH;
    else process.env.CORTEX_STATE_PATH = prevStatePath;
    try { rmSync(tmpStateDir, { recursive: true, force: true }); } catch { /* nothing */ }
  });

  it("merges priority action_items + decisions into a single chronological list", async () => {
    const now = new Date();
    const inOneHour = new Date(now.getTime() + 3_600_000);
    const inThreeHours = new Date(now.getTime() + 3 * 3_600_000);
    const yesterday = new Date(now.getTime() - 86_400_000);

    const rows: EngramMemory[] = [
      {
        id: "a-overdue",
        type: "action_item",
        content: "Send late slides",
        metadata: {
          source_id: "s1",
          tags: ["owner:matt", "due:" + yesterday.toISOString(), "status:open"],
          date: now.toISOString(),
        },
      },
      {
        id: "a-soon",
        type: "action_item",
        content: "Review draft before standup",
        metadata: {
          source_id: "s2",
          tags: ["owner:matt", "due:" + inOneHour.toISOString(), "status:open"],
          date: now.toISOString(),
        },
      },
      {
        id: "a-later",
        type: "action_item",
        content: "Pick up groceries this evening",
        metadata: {
          source_id: "s3",
          tags: ["owner:matt", "due:" + inThreeHours.toISOString(), "status:open"],
          date: now.toISOString(),
        },
      },
      {
        id: "d-fresh",
        type: "decision",
        content: "Ship pricing change Monday",
        metadata: {
          source_id: "d1",
          tags: ["type:decision"],
          date: now.toISOString(),
        },
      },
    ];

    const out = await todayTimelineWidget.handler(
      new URLSearchParams({ owner: "matt", limit: "20" }),
      mockCtx(rows),
    );

    expect(out.rows.length).toBeGreaterThan(0);

    const overdue = out.rows.find((r) => r.bucket === "overdue");
    expect(overdue).toBeDefined();
    expect(overdue!.type).toBe("action_item");
    expect(overdue!.urgency).toBe("high");

    const soon = out.rows.find((r) => r.bucket === "now");
    expect(soon).toBeDefined();
    expect(soon!.urgency).toBe("high");

    const decision = out.rows.find((r) => r.type === "decision");
    expect(decision).toBeDefined();
    expect(decision!.bucket).toBe("today");

    // Chronological sort — rows with time come first, sorted asc.
    const timed = out.rows.filter((r) => r.time);
    for (let i = 1; i < timed.length; i++) {
      expect(timed[i - 1]!.time! <= timed[i]!.time!).toBe(true);
    }
  });

  it("returns empty rows when constituent widgets fail", async () => {
    // No memories + no calendar — meetings widget falls back to "no token"
    // path, priorities returns empty rows.
    const out = await todayTimelineWidget.handler(
      new URLSearchParams(),
      mockCtx([]),
    );
    expect(out.rows).toEqual([]);
    expect(out.generatedAt).toBeTruthy();
  });

  it("workspace slug propagates from ctx.workspace", async () => {
    const ctx: WidgetContext = {
      ...mockCtx([]),
      workspace: { slug: "work" } as never,
    };
    const out = await todayTimelineWidget.handler(new URLSearchParams(), ctx);
    expect(out.workspace).toBe("work");
  });
});

describe("computeEndOfDayPrompt", () => {
  it("returns undefined before 16:00", () => {
    const now = new Date();
    now.setHours(15, 30, 0, 0);
    expect(computeEndOfDayPrompt(now, [])).toBeUndefined();
  });

  it("returns reason=soon between 16:00 and 18:00", () => {
    const now = new Date();
    now.setHours(16, 30, 0, 0);
    const r = computeEndOfDayPrompt(now, []);
    expect(r?.reason).toBe("soon");
  });

  it("returns reason=now after 18:00", () => {
    const now = new Date();
    now.setHours(18, 30, 0, 0);
    const r = computeEndOfDayPrompt(now, []);
    expect(r?.reason).toBe("now");
  });

  it("counts open action_items only (not decisions or completed)", () => {
    const now = new Date();
    now.setHours(17, 0, 0, 0);
    const rows = [
      {
        time: now.toISOString(),
        bucket: "today" as const,
        type: "action_item" as const,
        title: "open today",
        urgency: "medium" as const,
      },
      {
        time: null,
        bucket: "overdue" as const,
        type: "action_item" as const,
        title: "open overdue",
        urgency: "high" as const,
      },
      {
        time: now.toISOString(),
        bucket: "today" as const,
        type: "decision" as const,
        title: "decision is heads-up",
        urgency: "low" as const,
      },
      {
        time: now.toISOString(),
        bucket: "today" as const,
        type: "meeting" as const,
        title: "meeting",
        urgency: "medium" as const,
      },
    ];
    const r = computeEndOfDayPrompt(now, rows);
    // 1 today action_item + 1 overdue action_item = 2
    expect(r?.openCommitments).toBe(2);
  });
});
