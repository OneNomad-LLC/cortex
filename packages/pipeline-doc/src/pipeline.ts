import { defaultTrustForSource } from "@onenomad/przm-cortex-core";
import type { ClassifiedItem, MemoryMetadata } from "@onenomad/przm-cortex-core";
import type {
  Pipeline,
  PipelineContext,
  PipelineMemory,
} from "@onenomad/przm-cortex-pipeline-core";
import { chunkByHeading, type DocChunk } from "./chunk.js";

export interface DocPipelineOptions {
  /** Emit one memory for the whole doc in addition to per-chunk memories. */
  includeWhole?: boolean;
  /**
   * Minimum chunk size (characters) to emit. Very short chunks (e.g. a
   * heading with no body yet) are merged into whatever comes next. Default 80.
   */
  minChunkChars?: number;
}

/**
 * Content types this pipeline produces. Adapters for ticket systems
 * (Jira, Linear) may want `ticket` or we can extend ContentType later.
 * Today we always emit `doc`.
 */
export function createDocPipeline(
  opts: DocPipelineOptions = {},
): Pipeline<ClassifiedItem, PipelineMemory> {
  const minChunkChars = opts.minChunkChars ?? 80;

  return {
    id: "@onenomad/przm-cortex-pipeline-doc",
    version: "0.1.0",

    async run(
      input: ClassifiedItem,
      ctx: PipelineContext,
    ): Promise<PipelineMemory[]> {
      const baseMetadata = buildBaseMetadata(input, ctx.traceId);

      const rawChunks = chunkByHeading(input.content);
      const chunks = mergeShortChunks(rawChunks, minChunkChars);

      const memories: PipelineMemory[] = chunks.map((chunk, idx) => {
        const title = chunk.headingPath.length > 0
          ? chunk.headingPath.join(" > ")
          : input.title;

        const meta: MemoryMetadata = {
          ...baseMetadata,
          source_id: `${input.sourceId}#chunk-${idx}`,
          ...(title ? { title } : {}),
          tags: [
            ...(baseMetadata.tags ?? []),
            ...chunk.headingPath.map((h) => `heading:${h}`),
          ],
        };

        // Prepend the heading path so the memory stands on its own in search.
        const content =
          chunk.headingPath.length > 0
            ? `# ${chunk.headingPath.join(" > ")}\n\n${chunk.content}`
            : chunk.content;

        return { content, metadata: meta };
      });

      if (opts.includeWhole) {
        memories.push({
          content: input.content,
          metadata: { ...baseMetadata, source_id: `${input.sourceId}#whole` },
        });
      }

      return memories;
    },
  };
}

function buildBaseMetadata(
  input: ClassifiedItem,
  traceId: string | undefined,
): MemoryMetadata {
  const project: string | string[] =
    input.projects.length === 1 ? input.projects[0]! : input.projects;
  const trustDefaults = defaultTrustForSource(input.sourceType);

  return {
    domain: "work",
    source: input.sourceType,
    source_id: input.sourceId,
    source_url: input.sourceUrl,
    project,
    type: "doc",
    people: input.authors,
    date: input.updatedAt.toISOString(),
    confidence: input.confidence,
    sensitivity: trustDefaults.sensitivity,
    trust: trustDefaults.trust,
    ...(input.title ? { title: input.title } : {}),
    ...(input.parentId ? { parent_id: input.parentId } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    // Engagement context, stamped when the adapter classified with a
    // spaceToContext-style rule. Optional by design — simple setups that
    // only use spaceToProject leave these unset.
    ...(input.engagement ? { engagement: input.engagement } : {}),
    ...(input.subBrand ? { sub_brand: input.subBrand } : {}),
    ...(input.release ? { release: input.release } : {}),
    ...(input.team ? { team: input.team } : {}),
  };
}

/**
 * Fold any chunk below the threshold into the next chunk's content. Keeps
 * "## Section" with no body from becoming its own useless memory.
 */
function mergeShortChunks(chunks: DocChunk[], min: number): DocChunk[] {
  const out: DocChunk[] = [];
  let carry: DocChunk | null = null;

  for (const chunk of chunks) {
    const merged: DocChunk = carry
      ? {
          headingPath: chunk.headingPath,
          offset: carry.offset,
          content: `${carry.content}\n\n${chunk.content}`.trim(),
        }
      : chunk;

    if (merged.content.length < min) {
      carry = merged;
    } else {
      out.push(merged);
      carry = null;
    }
  }

  // Trailing short chunk with no follow-up: keep it anyway.
  if (carry) out.push(carry);
  return out;
}
