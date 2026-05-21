import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  RawSourceItem,
} from "@onenomad/przm-cortex-core";
import { BaseAdapter } from "@onenomad/przm-cortex-adapter-sdk";
import { SlackClient, type SlackMessage } from "./client.js";

export const slackConfigSchema = z.object({
  /** Slack workspace slug for URL building (e.g. `yourco` in yourco.slack.com). */
  workspace: z.string().default(""),
  /** Channel ids to sync. The bot must be a member of each. */
  channels: z.array(z.string().min(1)).default([]),
  historyDays: z.number().int().min(1).max(365).default(7),
  maxThreadsPerRun: z.number().int().min(0).default(100),
  channelToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
});

export type SlackConfig = z.infer<typeof slackConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: true,
  supportsAttachments: false,
  supportsComments: true,
  supportsRealTime: false,
};

interface RawSlackThread {
  channel: string;
  rootTs: string;
  messages: Array<SlackMessage & { displayName: string }>;
}

export class SlackAdapter extends BaseAdapter {
  readonly id = "slack";
  readonly name = "Slack";
  readonly version = "0.1.0";
  readonly configSchema = slackConfigSchema;
  readonly requiredSecrets = ["SLACK_BOT_TOKEN"] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/przm-cortex-pipeline-conversation"] as const;

  private client!: SlackClient;
  private cfg!: SlackConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const token = this.ctx.secrets.SLACK_BOT_TOKEN ?? "";
    if (!token) {
      throw new Error("slack adapter: SLACK_BOT_TOKEN must be set");
    }
    if (this.cfg.channels.length === 0) {
      throw new Error(
        "slack adapter: `channels` must be non-empty (explicitly opt into what to index)",
      );
    }
    this.client = new SlackClient({ token });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    const first = this.cfg.channels[0]!;
    const it = this.client.iterateHistory({ channel: first, limit: 1 });
    for await (const _ of it) return { channels: this.cfg.channels.length };
    return { channels: this.cfg.channels.length, empty: true };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const oldest =
      since ??
      new Date(Date.now() - this.cfg.historyDays * 86_400_000);
    let remaining =
      this.cfg.maxThreadsPerRun > 0 ? this.cfg.maxThreadsPerRun : Infinity;

    for (const channel of this.cfg.channels) {
      if (remaining <= 0) break;

      // Collect thread roots. A thread is any message whose ts == thread_ts,
      // or a standalone top-level message when there are no replies.
      const seen = new Set<string>();
      for await (const msg of this.client.iterateHistory({
        channel,
        oldestIso: oldest.toISOString(),
      })) {
        if (remaining <= 0) break;
        if (msg.subtype === "channel_join" || msg.subtype === "bot_message") {
          continue;
        }
        const rootTs = msg.thread_ts ?? msg.ts;
        if (seen.has(rootTs)) continue;
        seen.add(rootTs);

        let messages: SlackMessage[] = [msg];
        if (msg.reply_count && msg.reply_count > 0) {
          messages = await this.client.getThreadReplies(channel, rootTs);
        }

        const resolved = await this.resolveSpeakers(messages);
        remaining -= 1;

        yield {
          sourceId: `slack:thread:${channel}:${rootTs}`,
          raw: { channel, rootTs, messages: resolved } satisfies RawSlackThread,
        };
      }
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const item = raw.raw as RawSlackThread;
    const lines = item.messages
      .sort((a, b) => Number(a.ts) - Number(b.ts))
      .map((m) => {
        const iso = new Date(Number(m.ts) * 1000).toISOString();
        return `[${iso}] ${m.displayName}: ${m.text}`;
      });
    const content = lines.join("\n");

    const first = item.messages[0];
    const last = item.messages[item.messages.length - 1];

    const title = summarizeTitle(first?.text ?? "");
    const workspace = this.cfg.workspace || "yourco";
    const sourceUrl = this.client.threadUrl(workspace, item.channel, item.rootTs);

    const authors = [...new Set(item.messages.map((m) => m.displayName))];

    return {
      sourceId: raw.sourceId,
      sourceType: "slack",
      sourceUrl,
      title,
      content,
      contentType: "conversation",
      createdAt: first
        ? new Date(Number(first.ts) * 1000)
        : new Date(),
      updatedAt: last ? new Date(Number(last.ts) * 1000) : new Date(),
      authors,
      rawMetadata: {
        channel: item.channel,
        rootTs: item.rootTs,
        messageCount: item.messages.length,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const channel = item.rawMetadata.channel as string | undefined;
    const mapped = channel ? this.cfg.channelToProject[channel] : undefined;
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

  private async resolveSpeakers(
    messages: SlackMessage[],
  ): Promise<Array<SlackMessage & { displayName: string }>> {
    const out: Array<SlackMessage & { displayName: string }> = [];
    for (const msg of messages) {
      let displayName = "Unknown";
      if (msg.user) {
        const user = await this.client.resolveUser(msg.user);
        displayName =
          user?.profile?.display_name ||
          user?.profile?.real_name ||
          user?.real_name ||
          user?.name ||
          msg.user;
      } else if (msg.bot_id) {
        displayName = `bot:${msg.bot_id}`;
      }
      out.push({ ...msg, displayName });
    }
    return out;
  }
}

function summarizeTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Slack thread";
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

export const createAdapter: AdapterFactory = () => new SlackAdapter();
