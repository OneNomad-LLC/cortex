import type { NotionBlock, NotionRichText } from "./blocks.js";

export interface NotionClientOptions {
  apiKey: string;
  /** Notion API version header. Default: 2022-06-28. */
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
}

export interface NotionPage {
  id: string;
  object: "page";
  created_time: string;
  last_edited_time: string;
  parent: {
    type: "database_id" | "page_id" | "workspace";
    database_id?: string;
    page_id?: string;
    workspace?: boolean;
  };
  archived: boolean;
  icon?: { type: string; emoji?: string } | null;
  properties: Record<string, NotionProperty>;
  url: string;
}

export interface NotionProperty {
  id: string;
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  [key: string]: unknown;
}

export interface NotionDatabaseQueryResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface NotionBlocksResponse {
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Thin Notion API client. Bearer auth. Only the endpoints we need:
 *   - POST /databases/{id}/query     (iterate pages in a db, with sorts)
 *   - GET  /pages/{id}               (single page + properties)
 *   - GET  /blocks/{id}/children     (recursive block tree)
 */
export class NotionClient {
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(private readonly opts: NotionClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.notion.com/v1";
    this.apiVersion = opts.apiVersion ?? "2022-06-28";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pageSize = Math.min(opts.pageSize ?? 50, 100);
  }

  /**
   * Yield pages in a database, sorted by last_edited_time desc. Stop at
   * `sinceIso` when present.
   */
  async *iterateDatabase(args: {
    databaseId: string;
    sinceIso?: string;
    maxPages?: number;
  }): AsyncIterable<NotionPage> {
    let cursor: string | null = null;
    const cap = args.maxPages ?? 0;
    let emitted = 0;
    const since = args.sinceIso ? Date.parse(args.sinceIso) : undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const body: Record<string, unknown> = {
        page_size: this.pageSize,
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      };
      if (cursor) body.start_cursor = cursor;

      const data = await this.request<NotionDatabaseQueryResponse>(
        `/databases/${args.databaseId}/query`,
        { method: "POST", body },
      );

      for (const page of data.results) {
        if (since !== undefined && Date.parse(page.last_edited_time) <= since) {
          return;
        }
        yield page;
        emitted++;
        if (cap > 0 && emitted >= cap) return;
      }

      if (!data.has_more || !data.next_cursor) return;
      cursor = data.next_cursor;
    }
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>(`/pages/${pageId}`, { method: "GET" });
  }

  /** Fetch the full block tree for a page (recursively expands children). */
  async getBlockTree(pageId: string): Promise<NotionBlock[]> {
    return this.fetchChildren(pageId);
  }

  private async fetchChildren(blockId: string): Promise<NotionBlock[]> {
    const all: NotionBlock[] = [];
    let cursor: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const query = new URLSearchParams();
      query.set("page_size", String(this.pageSize));
      if (cursor) query.set("start_cursor", cursor);

      const data = await this.request<NotionBlocksResponse>(
        `/blocks/${blockId}/children?${query.toString()}`,
        { method: "GET" },
      );

      for (const block of data.results) {
        if (block.has_children) {
          block.children = await this.fetchChildren(block.id);
        }
        all.push(block);
      }

      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }

    return all;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const requestInit: RequestInit = {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "notion-version": this.apiVersion,
          "content-type": "application/json",
          accept: "application/json",
        },
        signal: controller.signal,
      };
      if (init.body !== undefined) requestInit.body = JSON.stringify(init.body);
      const res = await this.fetchImpl(url, requestInit);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Notion ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
