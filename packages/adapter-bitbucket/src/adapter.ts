import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  RawSourceItem,
} from "@cortex/core";
import { BaseAdapter, matchesGlobs } from "@cortex/adapter-sdk";
import { BitbucketClient, type BitbucketTreeEntry } from "./client.js";

export const bitbucketConfigSchema = z.object({
  workspace: z.string().min(1),
  repos: z.array(z.string().min(1)).default([]),
  branch: z.string().default("main"),
  includeGlobs: z
    .array(z.string().min(1))
    .default([
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.py",
      "**/*.go",
      "**/*.rs",
      "**/*.java",
      "**/*.md",
      "**/README*",
    ]),
  excludeGlobs: z
    .array(z.string().min(1))
    .default([
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/*.lock",
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
    ]),
  maxFilesPerRun: z.number().int().min(0).default(0),
  repoToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
});

export type BitbucketConfig = z.infer<typeof bitbucketConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: false, // v1 does a full tree walk per run
  supportsWebhooks: false,
  supportsAttachments: false,
  supportsComments: false,
  supportsRealTime: false,
};

interface RawBitbucketFile {
  repo: string;
  ref: string;
  entry: BitbucketTreeEntry;
  content: string;
}

export class BitbucketAdapter extends BaseAdapter {
  readonly id = "bitbucket";
  readonly name = "Bitbucket";
  readonly version = "0.1.0";
  readonly configSchema = bitbucketConfigSchema;
  readonly requiredSecrets = ["ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@cortex/pipeline-code"] as const;

  private client!: BitbucketClient;
  private cfg!: BitbucketConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const email = this.ctx.secrets.ATLASSIAN_EMAIL ?? "";
    const apiToken = this.ctx.secrets.ATLASSIAN_API_TOKEN ?? "";
    if (!email || !apiToken) {
      throw new Error(
        "bitbucket adapter: ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN must be set",
      );
    }
    if (this.cfg.repos.length === 0) {
      throw new Error(
        "bitbucket adapter: `repos` must be non-empty (don't scan an entire workspace by default)",
      );
    }
    this.client = new BitbucketClient({
      workspace: this.cfg.workspace,
      email,
      apiToken,
    });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    const first = this.cfg.repos[0]!;
    const it = this.client.walkRepo({ repo: first, ref: this.cfg.branch });
    for await (const _ of it) return { repos: this.cfg.repos.length };
    return { repos: this.cfg.repos.length, empty: true };
  }

  async *fetch(_since?: Date): AsyncIterable<RawSourceItem> {
    // v1 intentionally ignores `since` — Bitbucket's /src endpoint
    // doesn't expose a per-file mtime cheaply. When we add webhooks or
    // diff-based sync, this becomes incremental.
    let remaining =
      this.cfg.maxFilesPerRun > 0 ? this.cfg.maxFilesPerRun : Infinity;

    for (const repo of this.cfg.repos) {
      if (remaining <= 0) break;
      for await (const entry of this.client.walkRepo({
        repo,
        ref: this.cfg.branch,
      })) {
        if (remaining <= 0) break;
        if (
          !matchesGlobs(entry.path, this.cfg.includeGlobs, this.cfg.excludeGlobs)
        ) {
          continue;
        }
        const content = await this.client
          .getFileContent(repo, this.cfg.branch, entry.path)
          .catch((err) => {
            this.ctx.logger.warn("bitbucket.file_fetch_failed", {
              repo,
              path: entry.path,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          });
        if (content === null) continue;
        remaining -= 1;
        yield {
          sourceId: `bitbucket:${repo}@${this.cfg.branch}:${entry.path}`,
          raw: {
            repo,
            ref: this.cfg.branch,
            entry,
            content,
          } satisfies RawBitbucketFile,
        };
      }
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const item = raw.raw as RawBitbucketFile;
    const now = new Date(); // Bitbucket /src doesn't give per-file mtime in list view
    return {
      sourceId: raw.sourceId,
      sourceType: "bitbucket",
      sourceUrl: this.client.fileUrl(item.repo, item.ref, item.entry.path),
      title: `${item.repo}/${item.entry.path}`,
      content: item.content,
      contentType: "code",
      createdAt: now,
      updatedAt: now,
      authors: [],
      rawMetadata: {
        repo: item.repo,
        ref: item.ref,
        filePath: item.entry.path,
        size: item.entry.size,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    _ctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const repo = item.rawMetadata.repo as string | undefined;
    const mapped = repo ? this.cfg.repoToProject[repo] : undefined;
    if (mapped) {
      return {
        ...item,
        projects: [mapped],
        confidence: 0.95,
        classificationMethod: "rule",
      };
    }
    if (this.cfg.defaultProject) {
      return {
        ...item,
        projects: [this.cfg.defaultProject],
        confidence: 0.5,
        classificationMethod: "rule",
      };
    }
    return {
      ...item,
      projects: [],
      confidence: 0,
      classificationMethod: "rule",
    };
  }
}

export const createAdapter: AdapterFactory = () => new BitbucketAdapter();
