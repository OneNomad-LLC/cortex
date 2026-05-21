import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  ProjectCandidate,
  RawSourceItem,
  WebhookContext,
  WebhookHandler,
} from "@onenomad/przm-cortex-core";
import { BaseAdapter, matchesGlobs } from "@onenomad/przm-cortex-adapter-sdk";
import { tryReadGithubToken } from "@onenomad/przm-cortex-github-auth";
import { GithubClient, type GithubTreeEntry } from "./client.js";
import { createGithubWebhook } from "./webhook.js";

/**
 * Resolve a GitHub token from either the device-flow token file
 * (`~/.cortex/github-token.json`, written by `cortex github-login`)
 * or the GITHUB_TOKEN env var. File takes precedence so users who
 * authorized via the modern flow don't also have to set an env var.
 */
async function resolveGithubToken(
  envToken: string | undefined,
): Promise<string | undefined> {
  const fromFile = await tryReadGithubToken();
  if (fromFile?.accessToken) return fromFile.accessToken;
  return envToken && envToken.length > 0 ? envToken : undefined;
}

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
  supportsRealTime: true,
};

interface RawGithubFile {
  owner: string;
  repo: string;
  branch: string;
  entry: GithubTreeEntry;
  content: string;
}

/**
 * Webhook-delivered shape. transform() fetches content lazily from the
 * GitHub API so the webhook response stays under GitHub's 10s retry
 * window; the actual blob fetch happens after the 204 is sent.
 */
interface RawGithubWebhookFile {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  sha: string;
  _webhook: true;
}

export class GithubAdapter extends BaseAdapter {
  readonly id = "github";
  readonly name = "GitHub";
  readonly version = "0.1.0";
  readonly configSchema = githubConfigSchema;
  // No required secrets — onInit resolves the token from the
  // device-flow file (~/.cortex/github-token.json) first, then falls
  // back to GITHUB_TOKEN env if it's set. Both paths work; neither
  // is strictly required up front, so the registry shouldn't block
  // init on env-var presence.
  readonly requiredSecrets = [] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/przm-cortex-pipeline-code"] as const;

  private client!: GithubClient;
  private cfg!: GithubConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const token = await resolveGithubToken(this.ctx.secrets.GITHUB_TOKEN);
    if (!token) {
      throw new Error(
        "github adapter: no token found. Run `cortex github-login` (device flow, recommended) or set GITHUB_TOKEN in .env.",
      );
    }
    // `repos` non-empty is required for fetch + probeHealth but NOT for
    // discoverProjects — the whole point of pre-install discovery is
    // picking repos the adapter will then sync. Each caller that needs
    // a non-empty list guards below.
    this.client = new GithubClient({ token });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    if (this.cfg.repos.length === 0) {
      throw new Error(
        "github adapter: `repos` must be non-empty (safer than scanning every repo you can see)",
      );
    }
    const [owner, repo] = splitRepo(this.cfg.repos[0]!);
    const meta = await this.client.getRepo(owner, repo);
    return { sampleRepo: meta.full_name, defaultBranch: meta.default_branch };
  }

  async *fetch(_since?: Date): AsyncIterable<RawSourceItem> {
    if (this.cfg.repos.length === 0) {
      throw new Error(
        "github adapter: `repos` must be non-empty (safer than scanning every repo you can see)",
      );
    }
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
    const maybeWebhook = raw.raw as RawGithubWebhookFile;
    if (maybeWebhook._webhook === true) {
      return this.transformWebhook(raw, maybeWebhook);
    }
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

  private async transformWebhook(
    raw: RawSourceItem,
    item: RawGithubWebhookFile,
  ): Promise<NormalizedItem> {
    const fullName = `${item.owner}/${item.repo}`;
    // Fetch at the commit sha (not the branch) so the content we ingest
    // matches exactly what was just pushed — the branch might have moved
    // on by the time this runs.
    const ref = item.sha || item.branch;
    const content = await this.client.getFileContent(
      item.owner,
      item.repo,
      item.path,
      ref,
    );
    const now = new Date();
    return {
      sourceId: raw.sourceId,
      sourceType: "github",
      sourceUrl: this.client.fileUrl(
        item.owner,
        item.repo,
        item.branch,
        item.path,
      ),
      title: `${fullName}/${item.path}`,
      content,
      contentType: "code",
      createdAt: now,
      updatedAt: now,
      authors: [],
      rawMetadata: {
        repo: fullName,
        branch: item.branch,
        filePath: item.path,
        sha: item.sha,
        via: "webhook",
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
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
    return { ...item, ...(await this.fallbackClassify(item, cctx, this.cfg.defaultProject)) };
  }

  /**
   * GitHub webhook handler. Requires GITHUB_WEBHOOK_SECRET — refuses to
   * mount otherwise, because unsigned GitHub webhooks are trivially
   * spoofable. Returns undefined when the secret isn't set so the
   * receiver just skips this adapter.
   */
  override webhook(_ctx: WebhookContext): WebhookHandler | WebhookHandler[] {
    const secret = this.ctx.secrets.GITHUB_WEBHOOK_SECRET ?? "";
    if (!secret) {
      throw new Error(
        "github webhook: GITHUB_WEBHOOK_SECRET is required to mount the webhook route.",
      );
    }
    return createGithubWebhook({
      secret,
      includeGlobs: this.cfg.includeGlobs,
      excludeGlobs: this.cfg.excludeGlobs,
      repoToProject: this.cfg.repoToProject,
    });
  }

  /**
   * Surface every repo the auth'd user can read as a project
   * candidate. Archived + forks optional (include by default).
   *
   * Slug rule: owner-repo (kebab), truncated to 60 chars. Source
   * hint carries `github_repos: ["<owner>/<repo>"]` so the adapter
   * can route future syncs when the wizard writes a project entry.
   */
  async discoverProjects(): Promise<ProjectCandidate[]> {
    const candidates: ProjectCandidate[] = [];
    for await (const repo of this.client.listRepos()) {
      if (repo.archived) continue; // Skip archived repos by default.
      candidates.push({
        slug: slugify(`${repo.owner.login}-${repo.name}`),
        name: repo.full_name,
        ...(repo.description ? { description: repo.description } : {}),
        sourceHints: { github_repos: [repo.full_name] },
      });
    }
    return candidates;
  }
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "repo";
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
