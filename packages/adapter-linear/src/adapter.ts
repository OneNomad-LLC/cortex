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
import { LinearClient, type LinearIssue } from "./client.js";

export const linearConfigSchema = z.object({
  /** Team keys to sync. Empty = all accessible teams. */
  teams: z.array(z.string().min(1)).default([]),
  pageSize: z.number().int().min(1).max(250).default(50),
  maxIssuesPerRun: z.number().int().min(0).default(0),
  /** Map Linear team key → Cortex project slug. */
  teamToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
});

export type LinearConfig = z.infer<typeof linearConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: true,
  supportsAttachments: false,
  supportsComments: true,
  supportsRealTime: false,
};

export class LinearAdapter extends BaseAdapter {
  readonly id = "linear";
  readonly name = "Linear";
  readonly version = "0.1.0";
  readonly configSchema = linearConfigSchema;
  readonly requiredSecrets = ["LINEAR_API_KEY"] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/cortex-pipeline-doc"] as const;

  private client!: LinearClient;
  private cfg!: LinearConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const apiKey = this.ctx.secrets.LINEAR_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("linear adapter: LINEAR_API_KEY must be set");
    }
    this.client = new LinearClient({ apiKey, pageSize: this.cfg.pageSize });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    const iter = this.client.iterateIssues({
      ...(this.cfg.teams.length > 0 ? { teamKeys: this.cfg.teams } : {}),
      maxIssues: 1,
    });
    let count = 0;
    for await (const _ of iter) {
      count++;
      break;
    }
    return { reachable: true, sampledIssues: count };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const iter = this.client.iterateIssues({
      ...(this.cfg.teams.length > 0 ? { teamKeys: this.cfg.teams } : {}),
      ...(since ? { sinceIso: since.toISOString() } : {}),
      maxIssues: this.cfg.maxIssuesPerRun,
    });
    for await (const issue of iter) {
      yield { sourceId: `linear:issue:${issue.identifier}`, raw: issue };
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const issue = raw.raw as LinearIssue;
    const parts: string[] = [];
    parts.push(`# ${issue.identifier} · ${issue.title}`);

    const meta: string[] = [];
    if (issue.state?.name) meta.push(`Status: ${issue.state.name}`);
    if (issue.priorityLabel) meta.push(`Priority: ${issue.priorityLabel}`);
    if (issue.assignee?.name) meta.push(`Assignee: ${issue.assignee.name}`);
    const labels = issue.labels?.nodes?.map((l) => l.name) ?? [];
    if (labels.length > 0) meta.push(`Labels: ${labels.join(", ")}`);
    if (meta.length > 0) parts.push(meta.join(" · "));

    if (issue.description && issue.description.trim().length > 0) {
      parts.push(`## Description\n\n${issue.description.trim()}`);
    }

    for (const comment of issue.comments?.nodes ?? []) {
      const author = comment.user?.name ?? "unknown";
      const body = comment.body.trim();
      if (!body) continue;
      parts.push(`## Comment — ${author} (${comment.createdAt})\n\n${body}`);
    }

    const content = parts.join("\n\n");
    const authors: string[] = [];
    if (issue.creator?.email) authors.push(issue.creator.email);
    if (issue.assignee?.email && issue.assignee.email !== issue.creator?.email) {
      authors.push(issue.assignee.email);
    }

    return {
      sourceId: raw.sourceId,
      sourceType: "linear",
      sourceUrl: issue.url,
      title: `${issue.identifier}: ${issue.title}`,
      content,
      contentType: "doc",
      createdAt: new Date(issue.createdAt),
      updatedAt: new Date(issue.updatedAt),
      authors,
      rawMetadata: {
        issueId: issue.id,
        identifier: issue.identifier,
        teamKey: issue.team.key,
        teamId: issue.team.id,
        state: issue.state?.name,
        priority: issue.priorityLabel,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const teamKey = item.rawMetadata.teamKey as string | undefined;
    const mapped = teamKey ? this.cfg.teamToProject[teamKey] : undefined;
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
}

export const createAdapter: AdapterFactory = () => new LinearAdapter();
