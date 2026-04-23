import { describe, expect, it } from "vitest";
import { leaveSessionHandoff } from "../src/mcp/tools/leave-session-handoff.js";
import { readSessionHandoffs } from "../src/mcp/tools/read-session-handoffs.js";
import { resolveSessionHandoff } from "../src/mcp/tools/resolve-session-handoff.js";
import type { ToolContext } from "../src/mcp/tool.js";
import type { EngramClient, EngramMemory } from "../src/clients/engram.js";
import type { Logger } from "@cortex/core";

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

function inMemoryEngram(): {
  client: EngramClient;
  rows: EngramMemory[];
} {
  const rows: EngramMemory[] = [];
  const client: EngramClient = {
    async ingest(input) {
      const sourceId = (input.metadata as Record<string, unknown>).source_id as
        | string
        | undefined;
      const type = (input.metadata as Record<string, unknown>).type as
        | string
        | undefined;
      // Idempotent by source_id: replace existing if match.
      const existingIdx = rows.findIndex((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        return meta.source_id === sourceId;
      });
      const id = sourceId ?? `mem-${rows.length}`;
      const stored: EngramMemory = {
        id,
        content: input.content,
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
        ...(type ? { type } : {}),
      };
      if (existingIdx >= 0) rows[existingIdx] = stored;
      else rows.push(stored);
      return { id };
    },
    async search(args) {
      if (!args.type) return rows.slice();
      return rows.filter((r) => {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        return meta.type === args.type || r.type === args.type;
      });
    },
    async healthCheck() {
      return { healthy: true, message: "" };
    },
    async shutdown() {
      return;
    },
  };
  return { client, rows };
}

function mockCtx(engram: EngramClient): ToolContext {
  return {
    logger: nullLogger(),
    engram,
    persona: {} as never,
    taxonomy: {
      projects: [],
      people: [],
      findProject: (q: string) => undefined,
      findPerson: () => undefined,
      listProjects: () => [],
      findProjectBySlug: () => undefined,
      listPeople: () => [],
      findPersonBySlug: () => undefined,
      findPersonByEmail: () => undefined,
    } as never,
  };
}

describe("session handoff tools", () => {
  it("leave_session_handoff ingests a memory with type:session_handoff", async () => {
    const { client, rows } = inMemoryEngram();
    const out = await leaveSessionHandoff.handler(
      {
        summary: "Debug race condition in sync.ts",
        body: "Hit a deadlock when running cron mid-stream. Needs a retry backoff.",
        platform: "claude-code",
        project: "",
        openQuestions: ["Is the retry supposed to reset the cursor?"],
        nextSteps: ["Add jitter to the retry backoff"],
        fileRefs: ["packages/server/src/sync.ts:142"],
        tags: ["blocked", "infra"],
      },
      mockCtx(client),
    );

    expect(out.summary).toBe("Debug race condition in sync.ts");
    expect(out.sourceId.startsWith("handoff:")).toBe(true);
    expect(rows).toHaveLength(1);
    const meta = (rows[0]!.metadata ?? {}) as Record<string, unknown>;
    expect(meta.type).toBe("session_handoff");
    expect(meta.title).toBe("Debug race condition in sync.ts");
    const tags = meta.tags as string[];
    expect(tags).toContain("status:open");
    expect(tags).toContain("platform:claude-code");
    expect(tags).toContain("blocked");
    expect(rows[0]!.content).toContain("## Open questions");
    expect(rows[0]!.content).toContain("## Next steps");
    expect(rows[0]!.content).toContain("## File refs");
  });

  it("read_session_handoffs returns open handoffs newest-first", async () => {
    const { client } = inMemoryEngram();
    await leaveSessionHandoff.handler(
      {
        summary: "First handoff",
        body: "",
        platform: "claude-desktop",
        project: "",
        openQuestions: [],
        nextSteps: [],
        fileRefs: [],
        tags: [],
      },
      mockCtx(client),
    );
    // Tiny delay so dates sort predictably.
    await new Promise((r) => setTimeout(r, 5));
    await leaveSessionHandoff.handler(
      {
        summary: "Second handoff",
        body: "",
        platform: "claude-code",
        project: "",
        openQuestions: [],
        nextSteps: [],
        fileRefs: [],
        tags: [],
      },
      mockCtx(client),
    );

    const out = await readSessionHandoffs.handler(
      {
        limit: 10,
        includeResolved: false,
        platform: "",
        project: "",
        days: 14,
      },
      mockCtx(client),
    );
    expect(out.handoffs).toHaveLength(2);
    expect(out.handoffs[0]!.summary).toBe("Second handoff");
    expect(out.handoffs[1]!.summary).toBe("First handoff");
    expect(out.handoffs[0]!.resolved).toBe(false);
  });

  it("resolve_session_handoff flips status:open → status:resolved", async () => {
    const { client, rows } = inMemoryEngram();
    const { id } = await leaveSessionHandoff.handler(
      {
        summary: "Ship feature X",
        body: "",
        platform: "claude-code",
        project: "",
        openQuestions: [],
        nextSteps: [],
        fileRefs: [],
        tags: [],
      },
      mockCtx(client),
    );

    await resolveSessionHandoff.handler(
      { id, note: "Addressed in PR #42." },
      mockCtx(client),
    );

    // Memory should be updated in place — idempotent by source_id.
    expect(rows).toHaveLength(1);
    const tags = (rows[0]!.metadata as { tags: string[] }).tags;
    expect(tags).toContain("status:resolved");
    expect(tags).not.toContain("status:open");
    expect(rows[0]!.content).toContain("## Resolved");
    expect(rows[0]!.content).toContain("Addressed in PR #42.");

    // Default read filters it out.
    const openOnly = await readSessionHandoffs.handler(
      {
        limit: 10,
        includeResolved: false,
        platform: "",
        project: "",
        days: 14,
      },
      mockCtx(client),
    );
    expect(openOnly.handoffs).toHaveLength(0);

    // includeResolved: true surfaces it.
    const withResolved = await readSessionHandoffs.handler(
      {
        limit: 10,
        includeResolved: true,
        platform: "",
        project: "",
        days: 14,
      },
      mockCtx(client),
    );
    expect(withResolved.handoffs).toHaveLength(1);
    expect(withResolved.handoffs[0]!.resolved).toBe(true);
  });

  it("resolve_session_handoff throws when id doesn't exist", async () => {
    const { client } = inMemoryEngram();
    await expect(
      resolveSessionHandoff.handler(
        { id: "does-not-exist", note: "" },
        mockCtx(client),
      ),
    ).rejects.toThrow(/no handoff found/i);
  });

  it("read_session_handoffs filters by platform", async () => {
    const { client } = inMemoryEngram();
    await leaveSessionHandoff.handler(
      {
        summary: "Desktop handoff",
        body: "",
        platform: "claude-desktop",
        project: "",
        openQuestions: [],
        nextSteps: [],
        fileRefs: [],
        tags: [],
      },
      mockCtx(client),
    );
    await leaveSessionHandoff.handler(
      {
        summary: "Code handoff",
        body: "",
        platform: "claude-code",
        project: "",
        openQuestions: [],
        nextSteps: [],
        fileRefs: [],
        tags: [],
      },
      mockCtx(client),
    );

    const out = await readSessionHandoffs.handler(
      {
        limit: 10,
        includeResolved: false,
        platform: "claude-code",
        project: "",
        days: 14,
      },
      mockCtx(client),
    );
    expect(out.handoffs).toHaveLength(1);
    expect(out.handoffs[0]!.summary).toBe("Code handoff");
  });
});
