export interface LinearClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
}

export interface LinearIssue {
  id: string;
  identifier: string; // e.g. "ENG-42"
  title: string;
  description: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  priorityLabel?: string;
  state?: { name: string; type?: string };
  team: { id: string; key: string; name: string };
  assignee?: { id: string; name: string; email?: string };
  creator?: { id: string; name: string; email?: string };
  labels?: { nodes: Array<{ name: string }> };
  comments?: {
    nodes: Array<{
      id: string;
      body: string;
      createdAt: string;
      user?: { name: string; email?: string };
    }>;
  };
}

interface IssuesResponse {
  data?: {
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

const ISSUES_QUERY = /* GraphQL */ `
  query Issues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        description
        url
        createdAt
        updatedAt
        priorityLabel
        state { name type }
        team { id key name }
        assignee { id name email }
        creator { id name email }
        labels { nodes { name } }
        comments(first: 50) {
          nodes { id body createdAt user { name email } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Thin Linear GraphQL client. Personal API key auth. Only the one
 * operation we need (paginated issue listing with filters).
 */
export class LinearClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(private readonly opts: LinearClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.linear.app/graphql";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pageSize = Math.min(opts.pageSize ?? 50, 250);
  }

  async *iterateIssues(args: {
    teamKeys?: string[];
    sinceIso?: string;
    maxIssues?: number;
  }): AsyncIterable<LinearIssue> {
    const filter: Record<string, unknown> = {};
    if (args.teamKeys && args.teamKeys.length > 0) {
      filter.team = { key: { in: args.teamKeys } };
    }
    if (args.sinceIso) {
      filter.updatedAt = { gt: args.sinceIso };
    }

    let cursor: string | null = null;
    const cap = args.maxIssues ?? 0;
    let emitted = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res: IssuesResponse = await this.graphql<IssuesResponse>(
        ISSUES_QUERY,
        {
          first: this.pageSize,
          after: cursor,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
        },
      );
      const page = res.data?.issues;
      if (!page) return;

      for (const issue of page.nodes) {
        yield issue;
        emitted++;
        if (cap > 0 && emitted >= cap) return;
      }

      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return;
      cursor = page.pageInfo.endCursor;
    }
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          authorization: this.opts.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Linear ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
        );
      }
      const data = (await res.json()) as T & { errors?: Array<{ message: string }> };
      if (data.errors && data.errors.length > 0) {
        throw new Error(
          `Linear GraphQL errors: ${data.errors.map((e) => e.message).join("; ")}`,
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
