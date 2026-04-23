/**
 * Thin HTTP client for Atlassian Confluence Cloud REST API v2.
 * We only use the endpoints we need — space listing, page listing with
 * since-filter, and page retrieval with body formats.
 *
 * Docs: https://developer.atlassian.com/cloud/confluence/rest/v2/intro/
 */

export interface ConfluenceClientOptions {
  /** `<workspace>.atlassian.net` — pass the subdomain portion. */
  workspace: string;
  email: string;
  apiToken: string;
  /** Maximum items per page. Confluence caps at 250 for most endpoints. */
  pageSize?: number;
  /** Optional override for the base URL (tests). */
  baseUrl?: string;
  /** Optional fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
}

export interface ConfluencePageSummary {
  id: string;
  spaceId: string;
  status: string;
  title: string;
  parentId?: string;
  version?: { number: number; createdAt: string; authorId?: string };
  /** ISO 8601. Present on list responses from the v2 API. */
  createdAt?: string;
  _links?: { webui?: string };
}

export interface ConfluencePageFull extends ConfluencePageSummary {
  /** Populated when body-format=storage was requested. */
  body?: {
    storage?: { value: string; representation: "storage" };
    view?: { value: string; representation: "view" };
    atlas_doc_format?: { value: string; representation: "atlas_doc_format" };
  };
}

export interface PaginatedResponse<T> {
  results: T[];
  _links?: { next?: string };
}

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ConfluenceClientOptions) {
    this.baseUrl =
      opts.baseUrl ?? `https://${opts.workspace}.atlassian.net/wiki/api/v2`;
    this.authHeader =
      "Basic " +
      Buffer.from(`${opts.email}:${opts.apiToken}`, "utf8").toString("base64");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pageSize = Math.min(opts.pageSize ?? 50, 250);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** List spaces by key (or all if `keys` omitted). */
  async listSpaces(keys?: string[]): Promise<ConfluenceSpace[]> {
    const params = new URLSearchParams();
    params.set("limit", String(this.pageSize));
    if (keys && keys.length > 0) {
      for (const k of keys) params.append("keys", k);
    }
    const data = await this.get<PaginatedResponse<ConfluenceSpace>>(
      `/spaces?${params.toString()}`,
    );
    return data.results;
  }

  /** Iterate every space the authed user can read. Used for discovery. */
  async *iterateAllSpaces(): AsyncIterable<ConfluenceSpace> {
    const params = new URLSearchParams();
    params.set("limit", String(this.pageSize));
    let url: string | undefined = `/spaces?${params.toString()}`;
    while (url) {
      const data: PaginatedResponse<ConfluenceSpace> = await this.get<
        PaginatedResponse<ConfluenceSpace>
      >(url);
      for (const space of data.results) yield space;
      url = data._links?.next;
    }
  }

  /**
   * Yield pages in a space, newest first. Caller decides when to stop based
   * on `updatedAt` vs a cursor. v2 sorts descending by `-modified-date`.
   */
  async *iteratePages(args: {
    spaceId: string;
    /** Yield only pages updated strictly after this date if set. */
    sinceIso?: string;
    /** Cap total results (0 = unlimited). */
    maxPages?: number;
  }): AsyncIterable<ConfluencePageSummary> {
    const params = new URLSearchParams();
    params.set("space-id", args.spaceId);
    params.set("limit", String(this.pageSize));
    params.set("sort", "-modified-date");
    params.set("status", "current");

    let url: string | undefined = `/pages?${params.toString()}`;
    let emitted = 0;
    const cap = args.maxPages ?? 0;
    const since = args.sinceIso ? Date.parse(args.sinceIso) : undefined;

    while (url) {
      const data: PaginatedResponse<ConfluencePageSummary> =
        await this.get<PaginatedResponse<ConfluencePageSummary>>(url);
      for (const page of data.results) {
        if (since !== undefined) {
          const pageDate = page.version?.createdAt ?? page.createdAt;
          if (pageDate && Date.parse(pageDate) <= since) {
            // Sorted desc, so everything after this is older too.
            return;
          }
        }
        yield page;
        emitted++;
        if (cap > 0 && emitted >= cap) return;
      }
      url = data._links?.next;
    }
  }

  /** Retrieve a single page with body content. */
  async getPage(
    id: string,
    body: "storage" | "view" | "atlas_doc_format" = "storage",
  ): Promise<ConfluencePageFull> {
    const params = new URLSearchParams();
    params.set("body-format", body);
    return this.get<ConfluencePageFull>(`/pages/${id}?${params.toString()}`);
  }

  /**
   * Build a web URL for a page. The v2 API returns a relative path in
   * `_links.webui`; we prefix with the workspace origin.
   */
  pageUrl(page: ConfluencePageSummary): string {
    const rel = page._links?.webui;
    if (rel) {
      return `https://${this.opts.workspace}.atlassian.net/wiki${rel}`;
    }
    return `https://${this.opts.workspace}.atlassian.net/wiki/spaces/_/pages/${page.id}`;
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
          authorization: this.authHeader,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Confluence ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
