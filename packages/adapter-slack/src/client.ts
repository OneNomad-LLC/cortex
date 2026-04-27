export interface SlackClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text: string;
  reply_count?: number;
  subtype?: string;
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string; email?: string };
}

interface HistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface RepliesResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
}

interface UserInfoResponse {
  ok: boolean;
  error?: string;
  user?: SlackUser;
}

/**
 * Thin Slack Web API client. Endpoints used:
 *   - conversations.history   channel messages
 *   - conversations.replies   thread reply fetch
 *   - users.info              resolve user id → display name
 */
export class SlackClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userCache = new Map<string, SlackUser>();

  constructor(private readonly opts: SlackClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://slack.com/api";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Iterate channel messages newest-first. Respects `oldest` to limit
   * how far back we look.
   */
  async *iterateHistory(args: {
    channel: string;
    oldestIso?: string;
    limit?: number;
  }): AsyncIterable<SlackMessage> {
    const oldestTs = args.oldestIso
      ? String(Math.floor(Date.parse(args.oldestIso) / 1000))
      : undefined;
    let cursor: string | undefined;
    let emitted = 0;
    const cap = args.limit ?? 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({
        channel: args.channel,
        limit: "100",
        inclusive: "true",
      });
      if (oldestTs) params.set("oldest", oldestTs);
      if (cursor) params.set("cursor", cursor);

      const data = await this.call<HistoryResponse>(
        "conversations.history",
        params,
      );

      for (const msg of data.messages ?? []) {
        yield msg;
        emitted++;
        if (cap > 0 && emitted >= cap) return;
      }
      if (!data.has_more || !data.response_metadata?.next_cursor) return;
      cursor = data.response_metadata.next_cursor;
    }
  }

  /** Fetch all replies for a thread (root message + replies). */
  async getThreadReplies(
    channel: string,
    threadTs: string,
  ): Promise<SlackMessage[]> {
    const params = new URLSearchParams({
      channel,
      ts: threadTs,
      limit: "200",
    });
    const data = await this.call<RepliesResponse>(
      "conversations.replies",
      params,
    );
    return data.messages ?? [];
  }

  async resolveUser(userId: string): Promise<SlackUser | null> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    try {
      const params = new URLSearchParams({ user: userId });
      const data = await this.call<UserInfoResponse>("users.info", params);
      if (data.user) {
        this.userCache.set(userId, data.user);
        return data.user;
      }
      return null;
    } catch {
      return null;
    }
  }

  threadUrl(workspace: string, channel: string, threadTs: string): string {
    const p = threadTs.replace(".", "");
    return `https://${workspace}.slack.com/archives/${channel}/p${p}`;
  }

  /**
   * Send a message via `chat.postMessage`. Used by the notification
   * pipeline (Prong B). `channel` accepts a channel id (e.g. `C…`),
   * a DM channel id (`D…`), `@username`, or a self-DM via the user's
   * own `U…` id (Slack auto-opens an `im` channel on send).
   */
  async postMessage(args: {
    channel: string;
    text: string;
    /** Set to true if the text uses Slack's mrkdwn syntax. Default true. */
    mrkdwn?: boolean;
  }): Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }> {
    const url = `${this.baseUrl}/chat.postMessage`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = JSON.stringify({
        channel: args.channel,
        text: args.text,
        mrkdwn: args.mrkdwn ?? true,
      });
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          "content-type": "application/json; charset=utf-8",
          accept: "application/json",
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        return { ok: false, error: `http_${res.status}` };
      }
      const data = (await res.json()) as {
        ok: boolean;
        ts?: string;
        channel?: string;
        error?: string;
      };
      return data;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async call<T extends { ok: boolean; error?: string }>(
    method: string,
    params: URLSearchParams,
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Slack ${method} ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as T;
      if (!data.ok) {
        throw new Error(`Slack ${method} failed: ${data.error ?? "unknown"}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
