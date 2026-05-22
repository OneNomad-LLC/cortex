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

/**
 * Per-repo ingestion modes. Mirrors the `mode` parameter of the
 * `ingest_repo` MCP tool (Slice B):
 *   - `dossier` — produce a 1 brief + N decisions + N references summary
 *                 per repo. Default; what cortex KNOWS about the repo.
 *   - `full`    — chunk every source file into the vector store. The
 *                 historical behavior; useful when callers want raw
 *                 source search.
 *   - `both`    — produce BOTH a dossier AND full-file chunks. Most
 *                 expensive; pick only when both retrieval modes matter.
 */
export const githubModeSchema = z.enum(["dossier", "full", "both"]);
export type GithubMode = z.infer<typeof githubModeSchema>;

export const githubConfigSchema = z.object({
  /** `owner/repo` identifiers. */
  repos: z.array(z.string().min(1)).default([]),
  /** Empty = each repo's default branch. */
  branch: z.string().default(""),
  /**
   * Ingestion mode applied to every repo by default. The recommended
   * value is `dossier` — most queries want "what does cortex know about
   * this project", not raw source chunks. Per-repo overrides via
   * `repoModes` let power users opt specific repos into `full` or
   * `both` without flipping the whole adapter.
   */
  mode: githubModeSchema.default("dossier"),
  /**
   * Per-repo mode override keyed by `owner/repo`. Missing entries
   * (or `undefined` values) fall back to the adapter-level `mode`.
   */
  repoModes: z.record(githubModeSchema).optional(),
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

/**
 * Per-repo delegation surface. The server wires a concrete implementation
 * (typically a thin wrapper around the `ingest_repo` MCP tool's handler)
 * via {@link GithubAdapter.setRepoIngester}. Decoupled this way to avoid
 * the adapter package depending on `@onenomad/przm-cortex-server`.
 *
 * Slice B owns the matching `ingest_repo` tool signature. The shape here
 * is the consumer view — Cortex's server registry maps it onto the tool
 * handler's input contract at wire-time.
 */
export interface GithubRepoIngestRequest {
  /** Clone URL — `https://github.com/{owner}/{name}.git`. */
  path: string;
  /** Resolved mode for this specific repo. */
  mode: GithubMode;
  /** Project slug to stamp on every emitted memory. */
  project: string;
  /** Free-form tags forwarded to the ingest tool. */
  tags: string[];
  /** Web URL of the repo (no `.git` suffix) — used in memory metadata. */
  sourceUrl: string;
  /**
   * Skip work when the repo's HEAD SHA matches the last seen value
   * (server-side dedup). True for scheduled syncs; false when the user
   * explicitly asked for a re-derivation.
   */
  skipIfUnchanged: boolean;
}

export interface GithubRepoIngestResult {
  /** True when SHA gating short-circuited the run. */
  skipped?: boolean;
  /** Files chunked into memories (full + both modes). */
  filesIngested?: number;
  /** Chunks emitted across pipelines. */
  chunksIngested?: number;
  /** Dossier sections written (dossier + both modes). */
  dossierSections?: number;
}

export type RepoIngestFn = (
  req: GithubRepoIngestRequest,
) => Promise<GithubRepoIngestResult>;

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
  private repoIngester: RepoIngestFn | undefined;

  /**
   * Server-side wiring hook. The adapter registry calls this after
   * `init()` with a function that drives the `ingest_repo` MCP tool's
   * handler. When set, scheduled syncs delegate per-repo to the
   * configured `mode` (dossier / full / both) and the per-file walk
   * is bypassed.
   *
   * When unset, `fetch()` falls back to the legacy per-file walk +
   * `pipeline-code` flow so existing setups keep working unchanged.
   */
  setRepoIngester(fn: RepoIngestFn): void {
    this.repoIngester = fn;
  }

  /**
   * Resolve the effective mode for a `owner/repo` string. Per-repo
   * overrides win over the adapter-level default. Exposed for tests
   * and dashboard surfaces that need to mirror the routing decision.
   */
  resolveMode(fullName: string): GithubMode {
    return this.cfg.repoModes?.[fullName] ?? this.cfg.mode;
  }

  /**
   * Pick the project slug to stamp on a repo's ingested memories.
   * `repoToProject` wins; `defaultProject` is the fallback; finally
   * the literal "default" sentinel (same fallback `ingest_content` uses)
   * so we never call `ingest_repo` with an empty project.
   */
  resolveProject(fullName: string): string {
    const mapped = this.cfg.repoToProject[fullName];
    if (mapped && mapped.length > 0) return mapped;
    if (this.cfg.defaultProject.length > 0) return this.cfg.defaultProject;
    return "default";
  }

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

    // Delegated path: when the server wired a repoIngester (Slice B's
    // ingest_repo bridge), drive every repo through it per the resolved
    // mode. SHA-gated re-derivation lives in ingest_repo itself, so
    // scheduled runs no-op for unchanged repos — no work crosses the
    // wire to scheduler / pipelines.
    if (this.repoIngester) {
      for (const fullName of this.cfg.repos) {
        const [owner, repo] = splitRepo(fullName);
        const mode = this.resolveMode(fullName);
        const project = this.resolveProject(fullName);
        const req: GithubRepoIngestRequest = {
          path: `https://github.com/${owner}/${repo}.git`,
          mode,
          project,
          tags: [],
          sourceUrl: `https://github.com/${owner}/${repo}`,
          skipIfUnchanged: true,
        };
        try {
          const result = await this.repoIngester(req);
          this.ctx.logger.info("github.repo_ingested", {
            repo: fullName,
            mode,
            project,
            skipped: result.skipped ?? false,
            filesIngested: result.filesIngested ?? 0,
            chunksIngested: result.chunksIngested ?? 0,
            dossierSections: result.dossierSections ?? 0,
          });
        } catch (err) {
          this.ctx.logger.warn("github.repo_ingest_failed", {
            repo: fullName,
            mode,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.markSuccess();
      return;
    }

    // Legacy per-file walk + pipeline-code flow. Preserved so an older
    // server build (or a test harness that doesn't wire setRepoIngester)
    // keeps producing memories. Once every deployed server wires the
    // ingester this branch can be retired.
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
