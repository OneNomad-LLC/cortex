import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /**
   * One-line summary. "Debugging a race condition in sync.ts" —
   * something the next session can recognize at a glance.
   */
  summary: z.string().min(1),
  /** Optional longer markdown body. Think of it as a mini-note. */
  body: z.string().default(""),
  /**
   * Which Claude surface you're leaving from. Free-form but the
   * conventional values are: claude-desktop, claude-code,
   * claude-chrome, claude-api, mcp-client.
   */
  platform: z.string().default("unknown"),
  /**
   * Project slug if this handoff is tied to a specific project. The
   * next session's `summarize_recent` call will surface the handoff when
   * the same project is asked about.
   */
  project: z.string().default(""),
  /** Unresolved questions. Bulleted list formatted in markdown. */
  openQuestions: z.array(z.string()).default([]),
  /** Concrete next steps. Bulleted list formatted in markdown. */
  nextSteps: z.array(z.string()).default([]),
  /**
   * File references in the form "path/to/file.ts:42" or just
   * "path/to/file.ts". Displayed prominently so the next session can
   * jump straight to where work was paused.
   */
  fileRefs: z.array(z.string()).default([]),
  /**
   * Free-form tags on top of the structured fields. Useful for
   * "blocked", "waiting-on-review", project-specific markers, etc.
   */
  tags: z.array(z.string()).default([]),
});

interface Output {
  id: string;
  sourceId: string;
  createdAt: string;
  summary: string;
}

/**
 * Write a session handoff to Engram. Anyone reading
 * `read_session_handoffs` from the next Claude session picks up where
 * this one left off. The handoff lives as a regular memory with
 * `type: "session_handoff"`, so it's searchable alongside everything
 * else — a brief or decision can reference a handoff by sourceId.
 */
export const leaveSessionHandoff: McpTool<typeof inputSchema, Output> = {
  name: "leave_session_handoff",
  description:
    "Save a handoff note so another Claude session can resume the " +
    "conversation. Works across Claude Desktop, Claude Code, and " +
    "Claude for Chrome — any surface with access to Cortex. Include " +
    "a summary, optional body, open questions, next steps, and file " +
    "refs. Read the other end with `read_session_handoffs`.",
  inputSchema,

  async handler(input, ctx) {
    const id = randomUUID();
    const sourceId = `handoff:${id}`;
    const createdAt = new Date().toISOString();

    const projectSlug = input.project.trim();
    let resolvedProject: string | undefined;
    if (projectSlug) {
      const match = ctx.taxonomy.findProject(projectSlug);
      resolvedProject = match?.slug ?? projectSlug;
    }

    const content = buildHandoffBody(input);
    const tags = [
      "status:open",
      `platform:${input.platform}`,
      ...input.tags.map((t) => t.trim()).filter(Boolean),
    ];

    const metadata: Record<string, unknown> = {
      domain: "work",
      source: "manual",
      source_id: sourceId,
      source_url: `cortex://handoff/${id}`,
      type: "session_handoff",
      people: [],
      date: createdAt,
      confidence: 1.0,
      title: input.summary,
      tags,
      ...(resolvedProject ? { project: resolvedProject } : {}),
      ...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
    };

    await ctx.engram.ingest({ content, metadata });

    return {
      id,
      sourceId,
      createdAt,
      summary: input.summary,
    };
  },
};

function buildHandoffBody(
  input: z.output<typeof inputSchema>,
): string {
  const lines: string[] = [`# ${input.summary}`, ""];
  lines.push(`_Left from: ${input.platform}_`);
  lines.push("");

  if (input.body.trim()) {
    lines.push(input.body.trim());
    lines.push("");
  }

  if (input.openQuestions.length > 0) {
    lines.push("## Open questions");
    for (const q of input.openQuestions) lines.push(`- ${q}`);
    lines.push("");
  }

  if (input.nextSteps.length > 0) {
    lines.push("## Next steps");
    for (const s of input.nextSteps) lines.push(`- ${s}`);
    lines.push("");
  }

  if (input.fileRefs.length > 0) {
    lines.push("## File refs");
    for (const r of input.fileRefs) lines.push(`- \`${r}\``);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
