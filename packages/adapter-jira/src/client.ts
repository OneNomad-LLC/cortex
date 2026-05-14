import type { AdfNode } from "./adf.js";

export interface JiraClientOptions {
  workspace: string;
  email: string;
  apiToken: string;
  pageSize?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: AdfNode | null;
    issuetype?: { name: string };
    status?: { name: string };
    priority?: { name: string };
    assignee?: { accountId: string; displayName: string; emailAddress?: string };
    reporter?: { accountId: string; displayName: string; emailAddress?: string };
    project: { key: string; name: string; id: string };
    created: string;
    updated: string;
    labels?: string[];
    comment?: {
      comments: Array<{
        id: string;
        body: AdfNode | null;
        author?: { displayName: string; emailAddress?: string };
        created: string;
      }>;
    };
  };
}

interface SearchResponse {
  issues: JiraIssue[];
  startAt: number;
  maxResults: number;
  total: number;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  description?: string;
  projectTypeKey?: string;
  lead?: { accountId?: string; displayName?: string };
}

/**
 * Thin Jira Cloud REST v3 client. Just the endpoints we need:
 *   - /search with JQL for issue listing
 *   - /issue/{key} for a single issue with comments
 *
 * v3 uses Atlassian Document Format for description/comment bodies.
 */
export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: JiraClientOptions) {
    this.baseUrl =
      opts.baseUrl ?? `https://${opts.workspace}.atlassian.net/rest/api/3`;
    this.authHeader =
      "Basic " +
      Buffer.from(`${opts.email}:${opts.apiToken}`, "utf8").toString("base64");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pageSize = Math.min(opts.pageSize ?? 50, 100);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Iterate issues matching JQL, newest-updated first. Caller controls
   * when to stop based on the `updated` field.
   */
  async *iterateIssues(args: {
    jql: string;
    maxIssues?: number;
  }): AsyncIterable<JiraIssue> {
    const jql = args.jql.trim();
    const cap = args.maxIssues ?? 0;
    let startAt = 0;
    let emitted = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams();
      params.set("jql", jql);
      params.set("startAt", String(startAt));
      params.set("maxResults", String(this.pageSize));
      params.set(
        "fields",
        [
          "summary",
          "description",
          "issuetype",
          "status",
          "priority",
          "assignee",
          "reporter",
          "project",
          "created",
          "updated",
          "labels",
          "comment",
        ].join(","),
      );

      const page = await this.get<SearchResponse>(
        `/search?${params.toString()}`,
      );

      for (const issue of page.issues) {
        yield issue;
        emitted++;
        if (cap > 0 && emitted >= cap) return;
      }

      startAt += page.issues.length;
      if (startAt >= page.total || page.issues.length === 0) return;
    }
  }

  /** Build a browser URL for an issue. */
  issueUrl(issue: JiraIssue): string {
    return `https://${this.opts.workspace}.atlassian.net/browse/${issue.key}`;
  }

  /** Iterate every Jira project visible to the authed user. */
  async *iterateProjects(): AsyncIterable<JiraProject> {
    interface ProjectSearchResponse {
      values: JiraProject[];
      isLast?: boolean;
      nextPage?: string;
      startAt?: number;
      maxResults?: number;
      total?: number;
    }
    let startAt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(this.pageSize),
      });
      const data = await this.get<ProjectSearchResponse>(
        `/project/search?${params.toString()}`,
      );
      for (const p of data.values ?? []) yield p;
      if (data.isLast === true || !data.values || data.values.length === 0) {
        return;
      }
      startAt += data.values.length;
      if (data.total !== undefined && startAt >= data.total) return;
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
          authorization: this.authHeader,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Jira ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
