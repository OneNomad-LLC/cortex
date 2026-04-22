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
import { GithubClient, type GithubTreeEntry } from "./client.js";

export const githubConfigSchema = z.object({
  /** `owner/repo` identifiers. */
  repos: z.array(z.string().min(1)).default([]),
  /** Empty = each repo's default branch. */
  branch: z.string().default(""),
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
  /** Map `owner/repo` → Cortex project slug. */
  repoToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
});

export type GithubConfig = z.infer<typeof githubConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: false,
  supportsWebhooks: true,
  supportsAttachments: false,
  supportsComments: false,
  supportsRealTime: false,
};

interface RawGithubFile {
  owner: string;
  repo: string;
  branch: string;
  entry: GithubTreeEntry;
  content: string;
}

export class GithubAdapter extends BaseAdapter {
  readonly id = "github";
  readonly name = "GitHub";
  readonly version = "0.1.0";
  readonly configSchema = githubConfigSchema;
  readonly requiredSecrets = ["GITHUB_TOKEN"] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@cortex/pipeline-code"] as const;

  private client!: GithubClient;
  private cfg!: GithubConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const token = this.ctx.secrets.GITHUB_TOKEN ?? "";
    if (!token) {
      throw new Error("github adapter: GITHUB_TOKEN must be set");
    }
    if (this.cfg.repos.length === 0) {
      throw new Error(
        "github adapter: `repos` must be non-empty (safer than scanning every repo you can see)",
      );
    }
    this.client = new GithubClient({ token });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    const [owner, repo] = splitRepo(this.cfg.repos[0]!);
    const meta = await this.client.getRepo(owner, repo);
    return { sampleRepo: meta.full_name, defaultBranch: meta.default_branch };
  }

  async *fetch(_since?: Date): AsyncIterable<RawSourceItem> {
    let remaining =
      this.cfg.maxFilesPerRun > 0 ? this.cfg.maxFilesPerRun : Infinity;

    for (const fullName of this.cfg.repos) {
      if (remaining <= 0) break;
      const [owner, repo] = splitRepo(fullName);
      const branch =
        this.cfg.branch.trim().length > 0
          ? this.cfg.branch
          : (await this.client.getRepo(owner, repo)).default_branch;

      const sha = await this.client.getBranchSha(owner, repo, branch);
      const tree = await this.client.getTree(owner, repo, sha);
      if (tree.truncated) {
        this.ctx.logger.warn("github.tree_truncated", { repo: fullName });
      }

      for (const entry of tree.tree) {
        if (remaining <= 0) break;
        if (entry.type !== "blob") continue;
        if (
          !matchesGlobs(entry.path, this.cfg.includeGlobs, this.cfg.excludeGlobs)
        ) {
          continue;
        }
        const content = await this.client
          .getFileContent(owner, repo, entry.path, branch)
          .catch((err) => {
            this.ctx.logger.warn("github.file_fetch_failed", {
              repo: fullName,
              path: entry.path,
              error: err instanceof Error ? err.message : String(err),
            });
            return null;
          });
        if (content === null) continue;
        remaining -= 1;
        yield {
          sourceId: `github:${fullName}@${branch}:${entry.path}`,
          raw: {
            owner,
            repo,
            branch,
            entry,
            content,
          } satisfies RawGithubFile,
        };
      }
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const item = raw.raw as RawGithubFile;
    const now = new Date();
    const fullName = `${item.owner}/${item.repo}`;
    return {
      sourceId: raw.sourceId,
      sourceType: "github",
      sourceUrl: this.client.fileUrl(
        item.owner,
        item.repo,
        item.branch,
        item.entry.path,
      ),
      title: `${fullName}/${item.entry.path}`,
      content: item.content,
      contentType: "code",
      createdAt: now,
      updatedAt: now,
      authors: [],
      rawMetadata: {
        repo: fullName,
        branch: item.branch,
        filePath: item.entry.path,
        size: item.entry.size,
        sha: item.entry.sha,
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

function splitRepo(fullName: string): [string, string] {
  const idx = fullName.indexOf("/");
  if (idx < 0) {
    throw new Error(
      `github adapter: repo '${fullName}' must be in owner/repo form`,
    );
  }
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

export const createAdapter: AdapterFactory = () => new GithubAdapter();
