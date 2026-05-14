import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createCodePipeline } from "@onenomad/cortex-pipeline-code";
import { createConversationPipeline } from "@onenomad/cortex-pipeline-conversation";
import { createDocPipeline } from "@onenomad/cortex-pipeline-doc";
import {
  memoryMetadataSchema,
  type ClassifiedItem,
  type ContentType,
  type MemoryMetadata,
  type SourceType,
} from "@onenomad/cortex-core";
import { buildPipelineContext } from "../../sync.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

const inputSchema = z.object({
  content: z
    .string()
    .min(1, "content is required — pass the file contents Claude just read"),
  /**
   * Project slug from config/projects.yaml. When omitted, falls back to
   * the literal "default" project — useful for ad-hoc ingest paths
   * (file/url/repo from a renderer that doesn't surface a project
   * picker) that just want the content in the KB without per-project
   * routing. Phase 1D of the knowledge-engine repositioning will
   * collapse the project model entirely; this is the first step.
   *
   * When a non-default value is provided, it must exist in
   * config/projects.yaml — a typo there silently strands the memory
   * outside any project-filtered retrieval, so the validator below
   * fails loud.
   */
  project: z.string().min(1).default("default"),
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
  /**
   * Per-memory failures from this batch. Empty on full success. A
   * partial failure returns `ingested` < `memories.length` and the
   * failing rows here — the caller can retry just those.
   */
  errors: Array<{
    source_id: string;
    error: string;
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

    // Reject project slugs that don't exist in the taxonomy — a typo
    // here silently strands the memory outside any project-filtered
    // retrieval. Better to fail loud than let the row sink. The
    // sentinel "default" slug bypasses the lookup so ad-hoc ingest
    // paths (Phase 1D step 1) work without a per-project entry.
    let projectSlug: string;
    if (input.project === "default") {
      projectSlug = "default";
    } else {
      const projectMatch = ctx.taxonomy.findProject(input.project);
      if (!projectMatch) {
        throw new Error(
          `ingest_content: unknown project '${input.project}'. ` +
            `Add it via add_project first, pass an existing slug/alias from list_projects, or omit the field to use the "default" project.`,
        );
      }
      projectSlug = projectMatch.slug;
    }

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
      projects: [projectSlug],
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
    const errors: Output["errors"] = [];
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

      // Normalize + register the memory type before validation. The
      // registry is customer-extensible (built-ins + per-workspace
      // customTypes); anything new gets auto-registered with
      // source="auto" so it survives a restart, with a log so the
      // operator sees the drift. Garbage in -> we fall back to "note".
      if (typeof mem.metadata.type === "string") {
        const resolved = ctx.memoryTypes.register(mem.metadata.type, {
          source: "auto",
        });
        if (resolved) {
          if (!ctx.memoryTypes.isBuiltIn(resolved)) {
            ctx.logger.info("ingest_content.memory_type.auto_registered", {
              raw: mem.metadata.type,
              normalized: resolved,
              traceId,
            });
          }
          mem.metadata = { ...mem.metadata, type: resolved };
        } else {
          // Unrecoverable type string (empty after normalization).
          // Coerce to "note" rather than reject the whole memory.
          ctx.logger.warn("ingest_content.memory_type.coerced_to_note", {
            raw: mem.metadata.type,
            traceId,
          });
          mem.metadata = { ...mem.metadata, type: "note" };
        }
      }

      const memSourceId =
        typeof mem.metadata.source_id === "string"
          ? mem.metadata.source_id
          : input.sourceId;

      // Validate the metadata contract at runtime. Pipelines compose
      // metadata from many sources; a missing required field silently
      // breaks retrieval filters. Fail loud on a single row but keep
      // the batch going.
      const parsed = memoryMetadataSchema.safeParse(mem.metadata);
      if (!parsed.success) {
        ctx.logger.warn("ingest_content.metadata_invalid", {
          sourceId: memSourceId,
          traceId,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
        errors.push({
          source_id: memSourceId,
          error: `metadata contract violation: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
        });
        continue;
      }

      try {
        await ctx.engram.ingest({
          content: mem.content,
          metadata: parsed.data,
        });
        ingested++;
        preview.push({
          content_preview: mem.content.slice(0, 160),
          source_id: memSourceId,
          ...(typeof mem.metadata.title === "string"
            ? { title: mem.metadata.title }
            : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.error("ingest_content.ingest_failed", {
          sourceId: memSourceId,
          traceId,
          error: msg,
        });
        errors.push({ source_id: memSourceId, error: msg });
      }
    }

    ctx.logger.info("ingest_content.done", {
      sourceId: input.sourceId,
      project: projectSlug,
      type: input.type,
      ingested,
      failed: errors.length,
      traceId,
    });

    return {
      ingested,
      sourceId: input.sourceId,
      project: projectSlug,
      type: input.type,
      memories: preview,
      errors,
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
    // Pass-through: store the content as a single memory without running
    // a chunking/extraction pipeline. Briefs, decisions, notes, and
    // action items are already curated by the caller.
    case "note":
    case "decision":
    case "brief":
    case "digest":
    case "action_item":
    case "event":
    case "reference":
      return undefined;
  }
}

function passthroughMetadata(
  input: z.infer<typeof inputSchema>,
  classified: ClassifiedItem,
  traceId: string,
): MemoryMetadata {
  // Phase 1D residual: omit the project metadata stamp when the
  // sentinel "default" project is in use. Multi-tenant knowledge-
  // engine chunks belong to the workspace, not a sub-project; the
  // workspace tag is the actual scope. Explicit-project ingests
  // (a caller passed a real project slug from the taxonomy) still
  // get stamped so kb_search's project filter and any taxonomy-aware
  // retrieval keep working.
  const stampProject = input.project !== "default";
  return {
    domain: "work",
    source: input.source,
    source_id: input.sourceId,
    source_url: input.sourceUrl || "",
    ...(stampProject ? { project: input.project } : {}),
    type: classified.contentType,
    people: input.authors,
    date: classified.updatedAt.toISOString(),
    confidence: 1,
    trace_id: traceId,
    ...(input.tags.length > 0 ? { tags: input.tags } : {}),
  };
}
