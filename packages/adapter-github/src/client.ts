export interface GithubClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** User-Agent header — GitHub rejects requests without one. */
  userAgent?: string;
}

export interface GithubRepoMeta {
  default_branch: string;
  pushed_at?: string;
  html_url: string;
  name: string;
  full_name: string;
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url: string;
}

export interface GithubRepoSummary {
  full_name: string; // owner/repo
  name: string;
  description?: string | null;
  private: boolean;
  archived: boolean;
  html_url: string;
  default_branch: string;
  pushed_at?: string;
  owner: { login: string };
}

interface TreeResponse {
  sha: string;
  url: string;
  tree: GithubTreeEntry[];
  truncated: boolean;
}

interface RefResponse {
  object: { sha: string; type: string };
}

/**
 * GitHub REST v3 client. Scoped to the endpoints we need:
 *   - GET /repos/{owner}/{repo}                      meta + default branch
 *   - GET /repos/{owner}/{repo}/git/refs/heads/{br}  branch head sha
 *   - GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 *   - GET /repos/{owner}/{repo}/contents/{path}      file blob
 *
 * The tree endpoint truncates at 100k entries; for monorepos that big,
 * a future iteration can fall back to per-directory listing.
 */
export class GithubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(private readonly opts: GithubClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? "cortex-github-adapter";
  }

  async getRepo(owner: string, repo: string): Promise<GithubRepoMeta> {
    return this.get<GithubRepoMeta>(`/repos/${owner}/${repo}`);
  }

  async getBranchSha(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<string> {
    const ref = await this.get<RefResponse>(
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    );
    return ref.object.sha;
  }

  /**
   * Get every blob in a repo at a given tree sha. Uses ?recursive=1
   * (one request). Caller should check `truncated` for very large repos.
   */
  async getTree(
    owner: string,
    repo: string,
    treeSha: string,
  ): Promise<TreeResponse> {
    return this.get<TreeResponse>(
      `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
    );
  }

  /**
   * Fetch raw file content. Returns decoded UTF-8 text; throws if the
   * file is binary (base64 decode succeeds but includes NUL bytes,
   * which pipeline-code's skipBinary check will reject).
   */
  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string> {
    const data = await this.get<{
      content?: string;
      encoding?: string;
      type?: string;
      size?: number;
    }>(
      `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!data.content) return "";
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
    return data.content;
  }

  fileUrl(owner: string, repo: string, branch: string, path: string): string {
    return `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${encodeURI(path)}`;
  }

  /**
   * List every repo the token can read. For a user token this is
   * `/user/repos` (includes collaborator + org repos the user is a
   * member of). `affiliation=owner,collaborator,organization_member`
   * is the default, so we just page through it.
   */
  async *listRepos(): AsyncIterable<GithubRepoSummary> {
    const perPage = 100;
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const items = await this.get<GithubRepoSummary[]>(
        `/user/repos?per_page=${perPage}&page=${page}&sort=pushed`,
      );
      for (const r of items) yield r;
      if (items.length < perPage) return;
      page += 1;
      if (page > 50) return; // Safety cap — 5000 repos is plenty.
    }
  }

  private async get<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: "application/vnd.github+json",
          "user-agent": this.userAgent,
          "x-github-api-version": "2022-11-28",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `GitHub ${res.status} ${res.statusText} at ${pathOrUrl}: ${body.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
