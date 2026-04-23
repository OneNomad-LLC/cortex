import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  RawSourceItem,
} from "@onenomad/cortex-core";
import { BaseAdapter } from "@onenomad/cortex-adapter-sdk";
import { GoogleAuthClient, readGoogleToken } from "@onenomad/cortex-google-auth";
import { decodeMessageBody, type GmailPayload } from "./body.js";

export const gmailConfigSchema = z.object({
  /** Gmail search query. Uses Gmail search operators. */
  query: z.string().default("label:inbox newer_than:30d"),
  maxThreadsPerRun: z.number().int().min(0).default(50),
  /** Map Gmail label id → Cortex project slug. */
  labelToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
});

export type GmailConfig = z.infer<typeof gmailConfigSchema>;

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false,
  supportsAttachments: false,
  supportsComments: false,
  supportsRealTime: false,
};

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string; // ms epoch as string
  payload?: GmailPayload;
  snippet?: string;
}

interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
}

interface ThreadListResponse {
  threads?: Array<{ id: string; historyId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface RawGmailItem {
  thread: GmailThread;
}

export class GmailAdapter extends BaseAdapter {
  readonly id = "gmail";
  readonly name = "Gmail";
  readonly version = "0.1.0";
  readonly configSchema = gmailConfigSchema;
  readonly requiredSecrets = [] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/cortex-pipeline-doc"] as const;

  private auth!: GoogleAuthClient;
  private cfg!: GmailConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const token = await readGoogleToken();
    this.auth = new GoogleAuthClient({ token });
    if (!this.auth.hasAllScopes(SCOPES)) {
      this.ctx.logger.warn("gmail.scope_missing", {
        required: SCOPES,
        have: this.auth.scopes,
      });
    }
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    await this.auth.authorizedFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/profile`,
    );
    return { query: this.cfg.query };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const query = this.buildQuery(since);
    const cap = this.cfg.maxThreadsPerRun;
    let emitted = 0;
    let pageToken: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.min(cap > 0 ? cap - emitted : 100, 500)),
      });
      if (pageToken) params.set("pageToken", pageToken);

      const list = await this.auth.authorizedFetch<ThreadListResponse>(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params.toString()}`,
      );

      for (const summary of list.threads ?? []) {
        if (cap > 0 && emitted >= cap) return;
        const thread = await this.auth.authorizedFetch<GmailThread>(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${summary.id}?format=full`,
        );
        emitted += 1;
        yield {
          sourceId: `gmail:thread:${thread.id}`,
          raw: { thread } satisfies RawGmailItem,
        };
      }
      if (!list.nextPageToken) break;
      if (cap > 0 && emitted >= cap) break;
      pageToken = list.nextPageToken;
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const item = raw.raw as RawGmailItem;
    const { thread } = item;
    const messages = thread.messages ?? [];
    const first = messages[0];
    const last = messages[messages.length - 1];

    const subject =
      header(first?.payload, "Subject") ?? "(no subject)";
    const participants = new Set<string>();
    const parts: string[] = [`# ${subject}`];

    for (const msg of messages) {
      const from = header(msg.payload, "From") ?? "unknown";
      const date = header(msg.payload, "Date") ?? new Date(
        Number.parseInt(msg.internalDate ?? "0", 10),
      ).toISOString();
      const to = header(msg.payload, "To");
      const body = decodeMessageBody(msg.payload);
      if (!body.trim()) continue;

      const emailInFrom = extractEmail(from);
      if (emailInFrom) participants.add(emailInFrom);
      if (to) {
        for (const e of extractEmails(to)) participants.add(e);
      }

      parts.push(`## ${from} — ${date}`);
      parts.push(body.trim());
    }

    const createdAt = first?.internalDate
      ? new Date(Number.parseInt(first.internalDate, 10))
      : new Date();
    const updatedAt = last?.internalDate
      ? new Date(Number.parseInt(last.internalDate, 10))
      : createdAt;

    const allLabels = new Set<string>();
    for (const m of messages) for (const l of m.labelIds ?? []) allLabels.add(l);

    return {
      sourceId: raw.sourceId,
      sourceType: "email",
      sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
      title: subject,
      content: parts.join("\n\n"),
      contentType: "doc",
      createdAt,
      updatedAt,
      authors: [...participants],
      rawMetadata: {
        threadId: thread.id,
        messageCount: messages.length,
        labelIds: [...allLabels],
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const labels = (item.rawMetadata.labelIds as string[] | undefined) ?? [];
    for (const label of labels) {
      const mapped = this.cfg.labelToProject[label];
      if (mapped) {
        return {
          ...item,
          projects: [mapped],
          confidence: 0.9,
          classificationMethod: "rule",
        };
      }
    }
    return { ...item, ...(await this.fallbackClassify(item, cctx, this.cfg.defaultProject)) };
  }

  private buildQuery(since?: Date): string {
    const parts = [this.cfg.query];
    if (since) {
      const secs = Math.floor(since.getTime() / 1000);
      parts.push(`after:${secs}`);
    }
    return parts.filter((p) => p.trim().length > 0).join(" ");
  }
}

function header(
  payload: GmailPayload | undefined,
  name: string,
): string | undefined {
  const match = payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return match?.value;
}

function extractEmail(s: string): string | undefined {
  const m = /<([^>]+@[^>]+)>/.exec(s);
  if (m && m[1]) return m[1];
  const plain = /([^\s<>"']+@[^\s<>"']+)/.exec(s);
  return plain?.[1];
}

function extractEmails(s: string): string[] {
  const out: string[] = [];
  const re = /([^\s<>",]+@[^\s<>",]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) out.push(m[1].replace(/^[<]|[>]$/g, ""));
  }
  return out;
}

export const createAdapter: AdapterFactory = () => new GmailAdapter();
