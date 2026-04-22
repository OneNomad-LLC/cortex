import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  RawSourceItem,
  StreamContext,
} from "@cortex/core";
import { BaseAdapter, computeSourceId, contentHash } from "@cortex/adapter-sdk";
import { parseFrontmatter } from "./frontmatter.js";
import { walkVault } from "./walk.js";
import { watchVault } from "./watch.js";

const pathRuleSchema = z.object({
  prefix: z.string().min(1),
  project: z.string().min(1),
});

export const obsidianConfigSchema = z.object({
  vaultPath: z.string().min(1),
  /** First matching prefix wins. Evaluated in the order given. */
  pathToProject: z.array(pathRuleSchema).default([]),
  /** Directory or file names to skip at every level of the walk. */
  ignore: z
    .array(z.string())
    .default([".obsidian", ".trash", ".git", "node_modules"]),
  defaultProject: z.string().default(""),
  /**
   * File size cap in bytes. Files above this are skipped — dumps and
   * generated artifacts shouldn't land in memory. Default 1 MiB.
   */
  maxFileBytes: z.number().int().positive().default(1_048_576),
});

export type ObsidianConfig = z.infer<typeof obsidianConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false,
  supportsAttachments: false,
  supportsComments: false,
  supportsRealTime: true,
};

interface RawObsidianNote {
  relativePath: string;
  absolutePath: string;
  mtime: Date;
  source: string;
}

export class ObsidianAdapter extends BaseAdapter {
  readonly id = "obsidian";
  readonly name = "Obsidian";
  readonly version = "0.1.0";
  readonly configSchema = obsidianConfigSchema;
  readonly requiredSecrets = [] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@cortex/pipeline-doc"] as const;

  private cfg!: ObsidianConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    if (!this.cfg.vaultPath) {
      throw new Error("obsidian adapter: vaultPath is required");
    }
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    let count = 0;
    const iter = walkVault(this.cfg.vaultPath, {
      ignore: new Set(this.cfg.ignore),
    });
    for await (const _f of iter) {
      count++;
      if (count >= 50) break;
    }
    return { vaultPath: this.cfg.vaultPath, sampledFiles: count };
  }

  /**
   * Long-running filesystem watcher. Works alongside `fetch()` — the cron
   * sync still runs on schedule to pick up anything the watcher missed
   * (dropped fs events are common during editor saves), and the watcher
   * handles "just saved" events in near-real-time.
   */
  override stream(ctx: StreamContext): AsyncIterable<RawSourceItem> {
    return watchVault(
      {
        vaultPath: this.cfg.vaultPath,
        ignore: this.cfg.ignore,
        maxFileBytes: this.cfg.maxFileBytes,
      },
      ctx,
    );
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const sinceMs = since?.getTime() ?? 0;
    const iter = walkVault(this.cfg.vaultPath, {
      ignore: new Set(this.cfg.ignore),
    });

    for await (const file of iter) {
      if (file.sizeBytes > this.cfg.maxFileBytes) continue;
      if (sinceMs > 0 && file.mtimeMs <= sinceMs) continue;

      const source = await readFile(file.absolutePath, "utf8").catch(() => null);
      if (source === null) continue;

      const raw: RawObsidianNote = {
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        mtime: new Date(file.mtimeMs),
        source,
      };

      // source_id combines path + content hash so edits produce updates
      // rather than stale duplicates, and renames produce a new id.
      const sourceId = computeSourceId("obsidian", [
        file.relativePath,
        contentHash(source),
      ]);
      yield { sourceId, raw };
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const note = raw.raw as RawObsidianNote;
    const { metadata, body } = parseFrontmatter(note.source);

    const title =
      scalar(metadata.title) ??
      fileBaseName(note.relativePath) ??
      "Untitled note";

    const created = scalar(metadata.date ?? metadata.created) ?? note.mtime.toISOString();

    return {
      sourceId: raw.sourceId,
      sourceType: "obsidian",
      sourceUrl: pathToFileUrl(note.absolutePath),
      title,
      content: body,
      contentType: "note",
      createdAt: new Date(created),
      updatedAt: note.mtime,
      authors: [],
      rawMetadata: {
        relativePath: note.relativePath,
        frontmatter: metadata,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const relativePath = (item.rawMetadata.relativePath as string | undefined) ?? "";
    const frontmatter = (item.rawMetadata.frontmatter ?? {}) as Record<
      string,
      string | string[]
    >;

    // Frontmatter `project` wins if present — lets users override path rules.
    const fromMeta = frontmatter.project;
    if (typeof fromMeta === "string" && fromMeta.length > 0) {
      return {
        ...item,
        projects: [fromMeta],
        confidence: 0.99,
        classificationMethod: "manual",
      };
    }
    if (Array.isArray(fromMeta) && fromMeta.length > 0) {
      return {
        ...item,
        projects: fromMeta,
        confidence: 0.99,
        classificationMethod: "manual",
      };
    }

    for (const rule of this.cfg.pathToProject) {
      if (relativePath.startsWith(rule.prefix)) {
        return {
          ...item,
          projects: [rule.project],
          confidence: 0.9,
          classificationMethod: "path-based",
        };
      }
    }

    return { ...item, ...(await this.fallbackClassify(item, cctx, this.cfg.defaultProject)) };
  }
}

function scalar(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function fileBaseName(rel: string): string {
  const base = path.basename(rel);
  return base.replace(/\.md$/i, "");
}

function pathToFileUrl(abs: string): string {
  const resolved = path.resolve(abs);
  const normalized = resolved.replace(/\\/g, "/");
  return normalized.startsWith("/")
    ? `file://${encodeURI(normalized)}`
    : `file:///${encodeURI(normalized)}`;
}

export const createAdapter: AdapterFactory = () => new ObsidianAdapter();
