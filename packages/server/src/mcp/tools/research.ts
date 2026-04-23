import { z } from "zod";
import {
  createResearchPipeline,
  type ResearchContextItem,
} from "@onenomad/cortex-pipeline-research";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  /** The research question or topic. */
  topic: z.string().min(1),
  /** How many context memories to retrieve from Engram. */
  retrievalLimit: z.number().int().min(0).max(50).default(15),
  /** Only search within this project (slug or alias). */
  project: z.string().default(""),
  /** When true, skip the Engram write — return the brief without persisting. */
  dryRun: z.boolean().default(false),
});

interface Output {
  topic: string;
  retrieved: number;
  brief?: string;
  findings: Array<{ statement: string; citations?: number }>;
  persisted: Array<{ id: string; kind: "brief" | "finding" }>;
  hint?: string;
}

export const research: McpTool<typeof inputSchema, Output> = {
  name: "research",
  description:
    "Build reference knowledge about a topic. Pulls related memories " +
    "from Engram, synthesizes a markdown brief plus per-finding " +
    "reference memories, and (unless dryRun) stores them so future " +
    "queries can surface what Cortex now knows about this topic.",
  inputSchema,

  async handler(input, ctx) {
    if (!ctx.llmRouter) {
      return {
        topic: input.topic,
        retrieved: 0,
        findings: [],
        persisted: [],
        hint: "research requires an LLM router; none is configured. Enable a provider in config/cortex.yaml.",
      };
    }

    let projectSlug: string | undefined;
    if (input.project.trim()) {
      const project = ctx.taxonomy.findProject(input.project);
      if (!project) {
        return {
          topic: input.topic,
          retrieved: 0,
          findings: [],
          persisted: [],
          hint: `No project matched '${input.project}'.`,
        };
      }
      projectSlug = project.slug;
    }

    // 1. Retrieve prior context from Engram.
    const memories =
      input.retrievalLimit > 0
        ? await ctx.engram
            .search({
              query: input.topic,
              limit: input.retrievalLimit,
              domain: "work",
              ...(projectSlug ? { project: projectSlug } : {}),
            })
            .catch((err) => {
              ctx.logger.warn("research.retrieval_failed", {
                error: err instanceof Error ? err.message : String(err),
              });
              return [];
            })
        : [];

    const retrievedContext: ResearchContextItem[] = memories.map((m) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      return {
        sourceId: (meta.source_id as string | undefined) ?? m.id,
        ...(typeof meta.title === "string" ? { title: meta.title } : {}),
        ...(typeof meta.source_url === "string"
          ? { url: meta.source_url }
          : {}),
        content: m.content,
        ...(typeof meta.date === "string" ? { date: meta.date } : {}),
        ...(typeof meta.type === "string" ? { sourceType: meta.type } : {}),
      };
    });

    // 2. Run the pipeline.
    const pipeline = createResearchPipeline();
    const pipelineCtx = {
      logger: ctx.logger,
      signal: new AbortController().signal,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      llm: {
        async complete(args: {
          task: string;
          prompt: string;
          system?: string;
          maxTokens?: number;
          temperature?: number;
          signal?: AbortSignal;
        }): Promise<string> {
          const res = await ctx.llmRouter!.complete({
            task: args.task,
            messages: [
              ...(args.system
                ? [{ role: "system" as const, content: args.system }]
                : []),
              { role: "user" as const, content: args.prompt },
            ],
            ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
            ...(args.temperature !== undefined
              ? { temperature: args.temperature }
              : {}),
            ...(args.signal ? { signal: args.signal } : {}),
          });
          return res.content;
        },
      },
    };

    const produced = await pipeline.run(
      {
        topic: input.topic,
        retrievedContext,
        ...(projectSlug ? { projects: [projectSlug] } : {}),
      },
      pipelineCtx,
    );

    // 3. Optionally persist.
    const persisted: Output["persisted"] = [];
    const brief = produced.find((m) => m.metadata.source_id.endsWith("#brief"));
    const findings = produced.filter((m) =>
      m.metadata.source_id.includes("#finding-"),
    );

    if (!input.dryRun) {
      for (const mem of produced) {
        try {
          const res = await ctx.engram.ingest({
            content: mem.content,
            metadata: mem.metadata,
          });
          persisted.push({
            id: res.id,
            kind: mem.metadata.source_id.endsWith("#brief")
              ? "brief"
              : "finding",
          });
        } catch (err) {
          ctx.logger.warn("research.ingest_failed", {
            sourceId: mem.metadata.source_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      topic: input.topic,
      retrieved: retrievedContext.length,
      ...(brief ? { brief: brief.content } : {}),
      findings: findings.map((f) => ({
        statement:
          (f.metadata.title as string | undefined) ??
          f.content.slice(0, 180),
      })),
      persisted,
    };
  },
};
