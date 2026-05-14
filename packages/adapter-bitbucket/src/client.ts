export interface BitbucketClientOptions {
  workspace: string;
  email: string;
  apiToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
}

export interface BitbucketTreeEntry {
  type: "commit_file" | "commit_directory";
  path: string;
  size?: number;
  commit?: { hash: string };
}

export interface BitbucketRepo {
  slug: string;
  name: string;
  description?: string;
  links?: { html?: { href?: string } };
}

interface SrcListResponse {
  values: BitbucketTreeEntry[];
  next?: string;
}

/**
 * Bitbucket Cloud REST v2 client, scoped to the endpoints we need:
 *   - GET /repositories/{ws}/{slug}/src/{ref}/{path}             list
 *   - GET /repositories/{ws}/{slug}/src/{ref}/{path}?format=raw  content
 */
export class BitbucketClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(private readonly opts: BitbucketClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.bitbucket.org/2.0";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.authHeader =
      "Basic " +
      Buffer.from(`${opts.email}:${opts.apiToken}`, "utf8").toString("base64");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pageSize = Math.min(opts.pageSize ?? 100, 1000);
  }

  /**
   * List every file in a repo at a given ref, recursing into
   * subdirectories. Yields only `commit_file` entries.
   */
  async *walkRepo(args: {
    repo: string;
    ref: string;
  }): AsyncIterable<BitbucketTreeEntry> {
    const queue = [""]; // start at repo root
    while (queue.length > 0) {
      const dir = queue.shift()!;
      for await (const entry of this.listDir(args.repo, args.ref, dir)) {
        if (entry.type === "commit_directory") {
          queue.push(entry.path);
        } else if (entry.type === "commit_file") {
          yield entry;
        }
      }
    }
  }

  private async *listDir(
    repo: string,
    ref: string,
    dir: string,
  ): AsyncIterable<BitbucketTreeEntry> {
    const path = dir ? `/${encodeURI(dir)}` : "";
    let url: string | null =
      `${this.baseUrl}/repositories/${encodeURIComponent(this.opts.workspace)}/${encodeURIComponent(repo)}/src/${encodeURIComponent(ref)}${path}?pagelen=${this.pageSize}`;
    while (url) {
      const data: SrcListResponse = await this.getJson<SrcListResponse>(url);
      for (const entry of data.values) yield entry;
      url = data.next ?? null;
    }
  }

  /** Fetch raw file contents as UTF-8 text. */
  async getFileContent(
    repo: string,
    ref: string,
    path: string,
  ): Promise<string> {
    const url = `${this.baseUrl}/repositories/${encodeURIComponent(this.opts.workspace)}/${encodeURIComponent(repo)}/src/${encodeURIComponent(ref)}/${encodeURI(path)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          authorization: this.authHeader,
          accept: "text/plain, application/octet-stream, */*",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Bitbucket ${res.status} ${res.statusText} at ${path}: ${body.slice(0, 300)}`,
        );
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  fileUrl(repo: string, ref: string, path: string): string {
    return `https://bitbucket.org/${encodeURIComponent(this.opts.workspace)}/${encodeURIComponent(repo)}/src/${encodeURIComponent(ref)}/${encodeURI(path)}`;
  }

  /**
   * List every repo in the configured workspace. Used by the wizard's
   * post-install hook to surface project candidates.
   */
  async *listRepos(): AsyncIterable<BitbucketRepo> {
    interface RepoListResponse {
      values: BitbucketRepo[];
      next?: string;
    }
    let url: string | undefined =
      `${this.baseUrl}/repositories/${encodeURIComponent(this.opts.workspace)}?pagelen=${this.pageSize}&fields=values.slug,values.name,values.description,values.links.html.href,next`;
    while (url) {
      const data: RepoListResponse = await this.getJson<RepoListResponse>(url);
      for (const repo of data.values ?? []) yield repo;
      url = data.next;
    }
  }

  private async getJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          authorization: this.authHeader,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Bitbucket ${res.status} ${res.statusText} at ${url}: ${body.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
