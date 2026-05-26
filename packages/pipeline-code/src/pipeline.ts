import { defaultTrustForSource } from "@onenomad/przm-cortex-core";
import type {
  ClassifiedItem,
  ContentType,
  MemoryMetadata,
  SourceType,
} from "@onenomad/przm-cortex-core";
import type {
  Pipeline,
  PipelineContext,
  PipelineMemory,
} from "@onenomad/przm-cortex-pipeline-core";
import { chunkCode } from "./chunk.js";
import { detectLanguage, isProseLanguage } from "./language.js";

/** U+0000 as a pure-ASCII constant so the source file stays text-safe. */
const NULL_BYTE = String.fromCharCode(0);

export interface CodePipelineOptions {
  /** Max characters per code chunk. Default 6000 (~1200 tokens). */
  maxChunkChars?: number;
  /** Characters of overlap between fixed-window chunks. Default 200. */
  overlapChars?: number;
  /** Skip files above this many bytes. Default 256KB. */
  maxFileBytes?: number;
  /** Skip binary-looking content (null bytes) even when under byte cap. */
  skipBinary?: boolean;
}

export function createCodePipeline(
  opts: CodePipelineOptions = {},
): Pipeline<ClassifiedItem, PipelineMemory> {
  const maxChunkChars = opts.maxChunkChars ?? 6_000;
  const overlapChars = opts.overlapChars ?? 200;
  const maxFileBytes = opts.maxFileBytes ?? 256 * 1024;
  const skipBinary = opts.skipBinary ?? true;

  return {
    id: "@onenomad/przm-cortex-pipeline-code",
    version: "0.1.0",

    async run(
      input: ClassifiedItem,
      _ctx: PipelineContext,
    ): Promise<PipelineMemory[]> {
      const filePath =
        (input.rawMetadata.filePath as string | undefined) ?? input.title;
      const language = detectLanguage(filePath);
      const contentBytes = Buffer.byteLength(input.content, "utf8");

      if (contentBytes > maxFileBytes) return [];
      // Null byte = almost certainly binary. Cheap quick-reject so we
      // don't feed PDFs / images / compiled artifacts into Engram.
      if (skipBinary && input.content.indexOf(NULL_BYTE) !== -1) return [];

      const base = buildBaseMetadata(input, language, _ctx.traceId);
      const chunks = chunkCode(input.content, {
        language,
        maxChars: maxChunkChars,
        overlapChars,
      });

      return chunks.map((chunk, idx) => {
        const tags = [`language:${language}`];
        if (chunk.symbol) tags.push(`symbol:${chunk.symbol}`);

        const title = chunk.symbol
          ? `${filePath}:${chunk.symbol}`
          : chunks.length > 1
            ? `${filePath} (${idx + 1}/${chunks.length})`
            : filePath;

        const type: ContentType = isProseLanguage(language) ? "doc" : "code";

        const meta: MemoryMetadata = {
          ...base,
          source_id: `${input.sourceId}#${idx}`,
          type,
          title,
          tags,
        };

        return {
          content: chunk.content,
          metadata: meta,
        };
      });
    },
  };
}

function buildBaseMetadata(
  input: ClassifiedItem,
  language: string,
  traceId: string | undefined,
): MemoryMetadata {
  const project: string | string[] =
    input.projects.length === 1 ? input.projects[0]! : input.projects;
  const trustDefaults = defaultTrustForSource(input.sourceType as SourceType);

  return {
    domain: "work",
    source: input.sourceType as SourceType,
    source_id: input.sourceId,
    source_url: input.sourceUrl,
    project,
    type: "code",
    people: input.authors,
    date: input.updatedAt.toISOString(),
    confidence: input.confidence,
    sensitivity: trustDefaults.sensitivity,
    trust: trustDefaults.trust,
    tags: [`language:${language}`],
    ...(traceId ? { trace_id: traceId } : {}),
  };
}
