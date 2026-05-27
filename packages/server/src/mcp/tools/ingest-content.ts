import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createCodePipeline } from "@onenomad/przm-cortex-pipeline-code";
import { createConversationPipeline } from "@onenomad/przm-cortex-pipeline-conversation";
import { createDocPipeline } from "@onenomad/przm-cortex-pipeline-doc";
import {
  memoryMetadataSchema,
  type ClassifiedItem,
  type ContentType,
  type MemoryMetadata,
  type SourceType,
} from "@onenomad/przm-cortex-core";
import { buildPipelineContext } from "../../sync.js";
import {
  extractStructuredItems,
  slugify,
  type ActionItem,
  type Decision,
  type Entity,
} from "../../enrichment/extract-structured-items.js";
import {
  runExtractors,
} from "../../enrichment/extractor.js";
import { summaryExtractor } from "../../enrichment/extractor-summary.js";
import { keywordsExtractor } from "../../enrichment/extractor-keywords.js";
import { requireSessionWorkspace } from "../../session-workspace-helpers.js";
import type { McpTool } from "../tool.js";

// Content types that benefit from LLM extraction. Source code, briefs,
// digests, and the structured-item types themselves (action_item /
// decision / event / reference) are skipped — the first because there
// are no human commitments hiding in source files, the rest because
// they ARE the extracted output and feeding them back through the
// extractor would cycle.
const ENRICHABLE_TYPES = new Set<string>([
  "doc",
  "note",
  "meeting",
  "conversation",
]);

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
  /**
   * Counts of items the auto-enrichment pipeline produced from this
   * ingest. Each action_item / decision becomes its own memory with
   * the right type — searchable via kb_search type:action_item or
   * surfaced in the Cortex dashboard's by-type breakdown. Entities
   * are counted but not yet persisted (they would flood the KB
   * with low-signal rows; routing them into add_person / add_project
   * is a follow-up).
   *
   * Zero across all three when the LLM router isn't wired, when the
   * type isn't enrichable (code / brief / digest / etc.), or when
   * any of the raw chunk writes failed.
   */
  enriched?: {
    actionItems: number;
    decisions: number;
    entities: number;
  };
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

      // LLM-based ingest-time metadata extraction (ADR-020). Runs when
      // an LLM router is present AND at least one extractor is enabled
      // in ctx.extractorsConfig. Failure is non-fatal — the memory is
      // still ingested without enrichment.
      if (ctx.llmRouter && ctx.extractorsConfig) {
        try {
          const enrichmentPatch = await runExtractors({
            content: mem.content,
            extractors: [summaryExtractor, keywordsExtractor],
            config: ctx.extractorsConfig,
            ctx: {
              llmRouter: ctx.llmRouter,
              logger: ctx.logger,
              ...(traceId ? { traceId } : {}),
            },
          });
          if (Object.keys(enrichmentPatch).length > 0) {
            mem.metadata = { ...mem.metadata, ...enrichmentPatch };
          }
        } catch (err) {
          ctx.logger.warn("ingest_content.extractor_runner_failed", {
            error: err instanceof Error ? err.message : String(err),
            traceId,
          });
        }
      }

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

    // Auto-enrichment. After the raw chunks are stored, pull
    // structured items (action_items, decisions, entities) out of the
    // original content via the LLM router. Each extracted item lands
    // as its own memory with the right `type` so dashboard widgets
    // that filter by type pick them up. See AGENTS.md "one memory
    // per item" rule.
    //
    // Skipped when:
    //   - the LLM router isn't wired (workspace has no provider)
    //   - the type is not in ENRICHABLE_TYPES (source code, briefs,
    //     and the structured-item types themselves get nothing)
    //   - any of the raw chunk writes failed (don't enrich a partial
    //     ingest — the next retry will re-enrich cleanly)
    //
    // Synchronous in v1 — runs inline before the response returns.
    // Cost: one LLM call per ingest, ~$0.0002 at gpt-4o-mini Azure
    // pricing. Backpressure is the per-process job concurrency cap
    // applied to ingest_repo / ingest_url; ingest_content callers
    // are typically single chunks at human pace.
    let enrichedActionItems = 0;
    let enrichedDecisions = 0;
    let enrichedEntities = 0;
    if (
      ingested > 0 &&
      errors.length === 0 &&
      ctx.llmRouter &&
      ENRICHABLE_TYPES.has(input.type)
    ) {
      try {
        const extracted = await extractStructuredItems({
          content: input.content,
          llmRouter: ctx.llmRouter,
          logger: ctx.logger,
          ...(traceId ? { traceId } : {}),
        });

        const baseTags = [
          ...input.tags,
          `extracted-from:${input.sourceId}`,
          "auto-enriched",
        ];

        for (let i = 0; i < extracted.actionItems.length; i++) {
          await persistActionItem({
            item: extracted.actionItems[i]!,
            index: i,
            parentSourceId: input.sourceId,
            workspaceSlug: workspace.slug,
            project: projectSlug,
            sourceUrl: input.sourceUrl,
            sourceType: input.source as SourceType,
            now,
            traceId,
            tags: baseTags,
            ctx,
          });
          enrichedActionItems++;
        }
        for (let i = 0; i < extracted.decisions.length; i++) {
          await persistDecision({
            item: extracted.decisions[i]!,
            index: i,
            parentSourceId: input.sourceId,
            workspaceSlug: workspace.slug,
            project: projectSlug,
            sourceUrl: input.sourceUrl,
            sourceType: input.source as SourceType,
            now,
            traceId,
            tags: baseTags,
            ctx,
          });
          enrichedDecisions++;
        }
        // Entities aren't persisted as memories — they'd flood the
        // KB with low-signal "Alice is a person" rows. They get
        // surfaced in the response so a future taxonomy auto-suggest
        // can use them, and a follow-up PR can wire them into
        // add_person / add_project for high-confidence cases.
        enrichedEntities = extracted.entities.length;

        ctx.logger.info("ingest_content.enriched", {
          sourceId: input.sourceId,
          actionItems: enrichedActionItems,
          decisions: enrichedDecisions,
          entities: enrichedEntities,
          traceId,
        });
      } catch (err) {
        // Enrichment failure must NOT fail the ingest — the raw
        // chunks are already stored, the user got their content in.
        // Log + carry on.
        ctx.logger.warn("ingest_content.enrichment_failed", {
          sourceId: input.sourceId,
          error: err instanceof Error ? err.message : String(err),
          traceId,
        });
      }
    }

    ctx.logger.info("ingest_content.done", {
      sourceId: input.sourceId,
      project: projectSlug,
      type: input.type,
      ingested,
      failed: errors.length,
      enrichedActionItems,
      enrichedDecisions,
      enrichedEntities,
      traceId,
    });

    return {
      ingested,
      sourceId: input.sourceId,
      project: projectSlug,
      type: input.type,
      memories: preview,
      errors,
      enriched: {
        actionItems: enrichedActionItems,
        decisions: enrichedDecisions,
        entities: enrichedEntities,
      },
    };
  },
};

interface PersistArgs {
  index: number;
  parentSourceId: string;
  workspaceSlug: string;
  project: string;
  sourceUrl: string;
  sourceType: SourceType;
  now: Date;
  traceId: string | undefined;
  tags: string[];
  ctx: Parameters<NonNullable<typeof ingestContent.handler>>[1];
}

async function persistActionItem(
  args: PersistArgs & { item: ActionItem },
): Promise<void> {
  const { item } = args;
  const ownerSlug = item.owner ? slugify(item.owner) : null;
  const tags = [
    ...args.tags,
    "type:action_item",
    "status:open",
    ...(ownerSlug ? [`owner:${ownerSlug}`] : []),
    ...(item.due ? [`due:${item.due}`] : []),
    ...(item.priority ? [`priority:${item.priority}`] : []),
  ];
  const metadata = {
    domain: "work" as const,
    source: args.sourceType,
    source_id: `${args.parentSourceId}#action-${args.index}`,
    source_url: args.sourceUrl || "manual://enrichment",
    project: args.project,
    type: "action_item",
    people: ownerSlug ? [ownerSlug] : [],
    date: args.now.toISOString(),
    confidence: 0.7,
    title: item.description.slice(0, 120),
    tags,
    workspace: args.workspaceSlug,
    ...(args.traceId ? { trace_id: args.traceId } : {}),
  };
  const parsed = memoryMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    args.ctx.logger.warn("ingest_content.enrichment.action_item_invalid", {
      sourceId: metadata.source_id,
      issues: parsed.error.issues.map((i) => i.message),
    });
    return;
  }
  await args.ctx.engram.ingest({
    content: item.description,
    metadata: parsed.data,
  });
}

async function persistDecision(
  args: PersistArgs & { item: Decision },
): Promise<void> {
  const { item } = args;
  const tags = [...args.tags, "type:decision"];
  const body = item.context
    ? `${item.summary}\n\n${item.context}`
    : item.summary;
  const metadata = {
    domain: "work" as const,
    source: args.sourceType,
    source_id: `${args.parentSourceId}#decision-${args.index}`,
    source_url: args.sourceUrl || "manual://enrichment",
    project: args.project,
    type: "decision",
    people: [],
    date: args.now.toISOString(),
    confidence: 0.7,
    title: item.summary.slice(0, 120),
    tags,
    workspace: args.workspaceSlug,
    ...(args.traceId ? { trace_id: args.traceId } : {}),
  };
  const parsed = memoryMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    args.ctx.logger.warn("ingest_content.enrichment.decision_invalid", {
      sourceId: metadata.source_id,
      issues: parsed.error.issues.map((i) => i.message),
    });
    return;
  }
  await args.ctx.engram.ingest({
    content: body,
    metadata: parsed.data,
  });
}

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
