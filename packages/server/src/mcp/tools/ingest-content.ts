import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createCodePipeline } from "@onenomad/cortex-pipeline-code";
import { createConversationPipeline } from "@onenomad/cortex-pipeline-conversation";
import { createDocPipeline } from "@onenomad/cortex-pipeline-doc";
import type {
  ClassifiedItem,
  ContentType,
  MemoryMetadata,
  SourceType,
} from "@onenomad/cortex-core";
import { buildPipelineContext } from "../../sync.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  content: z
    .string()
    .min(1, "content is required — pass the file contents Claude just read"),
  /**
   * Project slug from config/projects.yaml. Required so the memory
   * lands in the taxonomy and can be recalled via get_project_context.
   */
  project: z.string().min(1),
  /**
   * One of the known content types. Picks the pipeline automatically:
   *   - doc: chunks by heading, one memory per section (default)
   *   - code: language-aware chunking for source files
   *   - meeting / conversation: transcript-shaped, multi-pass extraction
   *   - note / decision / brief / digest / action_item / event /
   *     reference: ingested as-is without chunking (pass-through)
   *
   * For `action_item`, include `tags: ["owner:<slug>", "due:<iso>",
   * "status:open"]` so the priorities widget can pick it up — those
   * three tags are what the dashboard reads.
   */
  type: z
    .enum([
      "doc",
      "code",
      "meeting",
      "conversation",
      "note",
      "decision",
      "brief",
      "digest",
      "action_item",
      "event",
      "reference",
    ])
    .default("doc"),
  /**
   * Stable id used as the dedupe key in Engram. Re-ingesting the same
   * sourceId updates the existing memory rather than creating a
   * duplicate. For local files, the absolute path is a good choice.
   */
  sourceId: z.string().min(1),
  title: z.string().default(""),
  sourceUrl: z.string().default(""),
  /**
   * Where this came from. Constrained to the canonical SourceType
   * enum so retrieval filters (`source:manual` etc.) stay consistent.
   * Default "manual" covers the Claude-reads-a-file flow; use
   * "obsidian" when piping in vault content, "email" for messages, etc.
   */
  source: z
    .enum([
      "manual",
      "loom",
      "google_meet",
      "confluence",
      "notion",
      "google_drive",
      "jira",
      "linear",
      "bitbucket",
      "github",
      "calendar",
      "slack",
      "teams",
      "email",
      "obsidian",
    ])
    .default("manual"),
  /** Person slugs from config/people.yaml. Unknowns are kept as-is. */
  authors: z.array(z.string()).default([]),
  /** Arbitrary tags. `language:X` is meaningful for code type. */
  tags: z.array(z.string()).default([]),
});

interface Output {
  ingested: number;
  sourceId: string;
  project: string;
  type: string;
  memories: Array<{
    content_preview: string;
    source_id: string;
    title?: string;
  }>;
}

/**
 * Ingest arbitrary content into Cortex's memory under a specific
 * project. Designed for the "Claude reads a local file and hands it
 * to Cortex over MCP" flow — Claude does the filesystem I/O, Cortex
 * does the classification + pipeline + storage.
 *
 * Pipeline is selected by `type`: doc (default) chunks by heading,
 * code chunks by language structure, meeting/conversation runs the
 * transcript extractor. Unknown/pass-through types are stored as a
 * single memory.
 */
export const ingestContent: McpTool<typeof inputSchema, Output> = {
  name: "ingest_content",
  description:
    "Ingest content into Cortex memory under a project. Takes the " +
    "raw text (markdown, source code, transcript, etc.), classifies " +
    "it by the `type` argument, runs the matching pipeline, and " +
    "stores the output in Engram with full metadata. Primary use: " +
    "Claude reads a local file with its own Read tool and passes " +
    "the contents here. sourceId acts as the dedupe key — re-ingest " +
    "updates the existing memory instead of duplicating.",
  inputSchema,

  async handler(input, ctx) {
    const workspace = await requireSessionWorkspace();
    const now = new Date();
    const title = input.title || input.sourceId.split("/").pop() || "untitled";
    const traceId = ctx.traceId ?? randomUUID();

    const contentType = toContentType(input.type);

    const classified: ClassifiedItem = {
      sourceType: input.source as SourceType,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl || "",
      title,
      content: input.content,
      contentType,
      createdAt: now,
      updatedAt: now,
      authors: input.authors,
      rawMetadata: {},
      projects: [input.project],
      confidence: 1,
      classificationMethod: "manual",
    };

    const pipelineCtx = buildPipelineContext({
      logger: ctx.logger.child({ tool: "ingest_content", traceId }),
      traceId,
      signal: new AbortController().signal,
      ...(ctx.llmRouter ? { llmRouter: ctx.llmRouter } : {}),
    });

    const pipeline = pickPipeline(input.type);
    const memories = pipeline
      ? await pipeline.run(classified, pipelineCtx)
      : // No pipeline for pass-through types — emit one memory as-is.
        [
          {
            content: input.content,
            metadata: passthroughMetadata(input, classified, traceId),
          },
        ];

    let ingested = 0;
    const preview: Output["memories"] = [];
    for (const mem of memories) {
      // Apply user-supplied tags on top of pipeline tags so they
      // survive the pipeline's own decoration.
      if (input.tags.length > 0) {
        const pipelineTags = Array.isArray(mem.metadata.tags)
          ? mem.metadata.tags
          : [];
        mem.metadata = {
          ...mem.metadata,
          tags: [...pipelineTags, ...input.tags],
        };
      }
      // Stamp the session's workspace so retrieval tools can filter
      // this memory back out of other-workspace sessions.
      mem.metadata = { ...mem.metadata, workspace: workspace.slug };
      await ctx.engram.ingest({
        content: mem.content,
        metadata: mem.metadata,
      });
      ingested++;
      preview.push({
        content_preview: mem.content.slice(0, 160),
        source_id:
          typeof mem.metadata.source_id === "string"
            ? mem.metadata.source_id
            : input.sourceId,
        ...(typeof mem.metadata.title === "string"
          ? { title: mem.metadata.title }
          : {}),
      });
    }

    ctx.logger.info("ingest_content.done", {
      sourceId: input.sourceId,
      project: input.project,
      type: input.type,
      ingested,
      traceId,
    });

    return {
      ingested,
      sourceId: input.sourceId,
      project: input.project,
      type: input.type,
      memories: preview,
    };
  },
};

function toContentType(t: z.infer<typeof inputSchema>["type"]): ContentType {
  // ClassifiedItem.contentType accepts the same enum strings.
  return t as ContentType;
}

function pickPipeline(
  t: z.infer<typeof inputSchema>["type"],
): ReturnType<
  typeof createDocPipeline | typeof createCodePipeline | typeof createConversationPipeline
> | undefined {
  switch (t) {
    case "doc":
      return createDocPipeline();
    case "code":
      return createCodePipeline();
    case "meeting":
    case "conversation":
      return createConversationPipeline();
    case "note":
    case "decision":
    case "brief":
    case "digest":
      return undefined;
  }
}

function passthroughMetadata(
  input: z.infer<typeof inputSchema>,
  classified: ClassifiedItem,
  traceId: string,
): MemoryMetadata {
  return {
    domain: "work",
    source: input.source,
    source_id: input.sourceId,
    source_url: input.sourceUrl || "",
    project: input.project,
    type: classified.contentType,
    people: input.authors,
    date: classified.updatedAt.toISOString(),
    confidence: 1,
    trace_id: traceId,
    ...(input.tags.length > 0 ? { tags: input.tags } : {}),
  };
}
