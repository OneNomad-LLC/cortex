import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  RawSourceItem,
} from "@cortex/core";
import { BaseAdapter } from "@cortex/adapter-sdk";
import {
  LoomClient,
  type LoomRecording,
  type LoomTranscript,
} from "./client.js";
import { transcriptToMarkdown } from "./transcript.js";

export const loomConfigSchema = z.object({
  workspace: z.string().min(1),
  /** Loom folder ids to scope. Empty = every folder the key can see. */
  folders: z.array(z.string().min(1)).default([]),
  pageSize: z.number().int().min(1).max(200).default(50),
  maxRecordingsPerRun: z.number().int().min(0).default(0),
  /** Map folderId → Cortex project slug. */
  folderToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
  /**
   * When true, recordings without a ready transcript are skipped
   * (processing in progress, unsupported media, etc.). Safer default
   * than trying to ingest titles/descriptions alone.
   */
  skipWithoutTranscript: z.boolean().default(true),
});

export type LoomConfig = z.infer<typeof loomConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false,
  supportsAttachments: false,
  supportsComments: false,
  supportsRealTime: false,
};

interface RawLoomItem {
  recording: LoomRecording;
  transcript: LoomTranscript | null;
}

export class LoomAdapter extends BaseAdapter {
  readonly id = "loom";
  readonly name = "Loom";
  readonly version = "0.1.0";
  readonly configSchema = loomConfigSchema;
  readonly requiredSecrets = ["LOOM_API_KEY"] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@cortex/pipeline-meeting"] as const;

  private client!: LoomClient;
  private cfg!: LoomConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const apiKey = this.ctx.secrets.LOOM_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("loom adapter: LOOM_API_KEY must be set");
    }
    this.client = new LoomClient({
      apiKey,
      workspace: this.cfg.workspace,
      pageSize: this.cfg.pageSize,
    });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    let count = 0;
    const iter = this.client.iterateRecordings({ maxRecordings: 1 });
    for await (const _ of iter) {
      count++;
      break;
    }
    return { workspace: this.cfg.workspace, sampledRecordings: count };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const iter = this.client.iterateRecordings({
      ...(this.cfg.folders.length > 0 ? { folders: this.cfg.folders } : {}),
      ...(since ? { sinceIso: since.toISOString() } : {}),
      maxRecordings: this.cfg.maxRecordingsPerRun,
    });

    for await (const recording of iter) {
      const transcript = await this.client
        .getTranscript(recording.id)
        .catch((err) => {
          this.ctx.logger.warn("loom.transcript_fetch_failed", {
            recordingId: recording.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });

      if (this.cfg.skipWithoutTranscript && !transcript) {
        continue;
      }

      yield {
        sourceId: `loom:rec:${recording.id}`,
        raw: { recording, transcript } satisfies RawLoomItem,
      };
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const item = raw.raw as RawLoomItem;
    const { recording, transcript } = item;

    const transcriptText = transcript
      ? transcriptToMarkdown(transcript.segments)
      : "";

    const parts: string[] = [];
    if (recording.description && recording.description.trim().length > 0) {
      parts.push(recording.description.trim());
    }
    if (transcriptText) {
      parts.push(transcriptText);
    }
    const content = parts.join("\n\n");

    const authors: string[] = [];
    if (recording.owner?.email) authors.push(recording.owner.email);
    for (const viewer of recording.viewers ?? []) {
      if (viewer.email && !authors.includes(viewer.email)) {
        authors.push(viewer.email);
      }
    }

    return {
      sourceId: raw.sourceId,
      sourceType: "loom",
      sourceUrl: recording.url,
      title: recording.title,
      content,
      contentType: "meeting",
      createdAt: new Date(recording.createdAt),
      updatedAt: new Date(recording.updatedAt),
      authors,
      rawMetadata: {
        recordingId: recording.id,
        folderId: recording.folderId,
        durationSeconds: recording.durationSeconds,
        hasTranscript: Boolean(transcript),
        language: transcript?.language ?? null,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    _ctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const folderId = item.rawMetadata.folderId as string | undefined;
    const mapped = folderId ? this.cfg.folderToProject[folderId] : undefined;
    if (mapped) {
      return {
        ...item,
        projects: [mapped],
        confidence: 0.95,
        classificationMethod: "rule",
      };
    }
    if (this.cfg.defaultProject) {
      return {
        ...item,
        projects: [this.cfg.defaultProject],
        confidence: 0.5,
        classificationMethod: "rule",
      };
    }
    // No folder rule and no default — leave unclassified for the review
    // queue. pipeline-meeting will still run and attach project: [] to
    // every memory it emits.
    return {
      ...item,
      projects: [],
      confidence: 0,
      classificationMethod: "rule",
    };
  }
}

export const createAdapter: AdapterFactory = () => new LoomAdapter();
