import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  NormalizedItem,
  ProjectCandidate,
  RawSourceItem,
} from "@onenomad/cortex-core";
import { BaseAdapter } from "@onenomad/cortex-adapter-sdk";
import { adfToMarkdown } from "./adf.js";
import { JiraClient, type JiraIssue } from "./client.js";

/** Full engagement/sub-brand/project tuple for a single Jira project key. */
export const projectContextSchema = z.object({
  /** Engagement slug — maps to the `engagement:*` domain and engagements.yaml. */
  engagement: z.string().min(1).optional(),
  /** Sub-brand slug within the engagement (e.g. "jiffy-lube"). */
  subBrand: z.string().min(1).optional(),
  /** Cortex project slug — same meaning as projects.yaml; becomes the `project` metadata field. */
  project: z.string().min(1),
  /** Dev team slug if the project is owned by a specific team. */
  team: z.string().min(1).optional(),
});

export type ProjectContext = z.infer<typeof projectContextSchema>;

export const jiraConfigSchema = z.object({
  workspace: z.string().min(1),
  /** Jira project keys to sync. Empty = fall back to `jql` or everything. */
  projects: z.array(z.string().min(1)).default([]),
  /**
   * Extra JQL filter appended to the project-keys clause. E.g.
   *   "resolution = Unresolved" or "updated >= -30d"
   */
  jql: z.string().default(""),
  pageSize: z.number().int().min(1).max(100).default(50),
  maxIssuesPerRun: z.number().int().min(0).default(0),
  /**
   * Shorthand classifier: Jira project key -> Cortex project slug. Used when
   * the only context that matters is the Cortex project. Pairs with the
   * richer `projectKeyToContext` for full engagement context.
   */
  projectToCortex: z.record(z.string()).default({}),
  /**
   * Rich classifier: Jira project key -> full context tuple
   * `{engagement, subBrand, project, team}`. When present, fields are
   * stamped onto every memory emitted from that Jira project. Falls back
   * to `projectToCortex` when a key isn't in this map.
   */
  projectKeyToContext: z.record(projectContextSchema).default({}),
});

export type JiraConfig = z.infer<typeof jiraConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false,
  supportsAttachments: true,
  supportsComments: true,
  supportsRealTime: false,
};

export class JiraAdapter extends BaseAdapter {
  readonly id = "jira";
  readonly name = "Jira";
  readonly version = "0.1.0";
  readonly configSchema = jiraConfigSchema;
  readonly requiredSecrets = ["ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/cortex-pipeline-doc"] as const;

  private client!: JiraClient;
  private cfg!: JiraConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const email = this.ctx.secrets.ATLASSIAN_EMAIL ?? "";
    const apiToken = this.ctx.secrets.ATLASSIAN_API_TOKEN ?? "";
    if (!email || !apiToken) {
      throw new Error(
        "jira adapter: ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN must be set",
      );
    }
    this.client = new JiraClient({
      workspace: this.cfg.workspace,
      email,
      apiToken,
      pageSize: this.cfg.pageSize,
    });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    // Cheap myself call — just list 1 issue with whatever JQL is configured.
    const it = this.client.iterateIssues({
      jql: this.buildJql(),
      maxIssues: 1,
    });
    let count = 0;
    for await (const _issue of it) {
      count++;
      break;
    }
    return { reachable: true, sampledIssues: count };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const jql = this.buildJql(since);
    const iter = this.client.iterateIssues({
      jql,
      maxIssues: this.cfg.maxIssuesPerRun,
    });
    for await (const issue of iter) {
      yield { sourceId: `jira:issue:${issue.key}`, raw: issue };
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const issue = raw.raw as JiraIssue;
    const parts: string[] = [];
    parts.push(`# ${issue.key} · ${issue.fields.summary}`);

    const meta: string[] = [];
    if (issue.fields.issuetype?.name) meta.push(`Type: ${issue.fields.issuetype.name}`);
    if (issue.fields.status?.name) meta.push(`Status: ${issue.fields.status.name}`);
    if (issue.fields.priority?.name) meta.push(`Priority: ${issue.fields.priority.name}`);
    if (issue.fields.assignee?.displayName)
      meta.push(`Assignee: ${issue.fields.assignee.displayName}`);
    if (issue.fields.labels && issue.fields.labels.length > 0)
      meta.push(`Labels: ${issue.fields.labels.join(", ")}`);
    if (meta.length > 0) parts.push(meta.join(" · "));

    const description = adfToMarkdown(issue.fields.description ?? null);
    if (description) {
      parts.push(`## Description\n\n${description}`);
    }

    for (const comment of issue.fields.comment?.comments ?? []) {
      const author = comment.author?.displayName ?? "unknown";
      const body = adfToMarkdown(comment.body);
      if (!body) continue;
      parts.push(`## Comment — ${author} (${comment.created})\n\n${body}`);
    }

    const content = parts.join("\n\n");
    const authors: string[] = [];
    if (issue.fields.reporter?.emailAddress)
      authors.push(issue.fields.reporter.emailAddress);
    if (
      issue.fields.assignee?.emailAddress &&
      issue.fields.assignee.emailAddress !== issue.fields.reporter?.emailAddress
    ) {
      authors.push(issue.fields.assignee.emailAddress);
    }

    return {
      sourceId: raw.sourceId,
      sourceType: "jira",
      sourceUrl: this.client.issueUrl(issue),
      title: `${issue.key}: ${issue.fields.summary}`,
      content,
      contentType: "doc",
      createdAt: new Date(issue.fields.created),
      updatedAt: new Date(issue.fields.updated),
      authors,
      rawMetadata: {
        issueKey: issue.key,
        projectKey: issue.fields.project.key,
        projectName: issue.fields.project.name,
        status: issue.fields.status?.name,
        issueType: issue.fields.issuetype?.name,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const projectKey = item.rawMetadata.projectKey as string | undefined;

    // Rich mapping wins — carries the full engagement/sub-brand/team tuple.
    const ctx = projectKey ? this.cfg.projectKeyToContext[projectKey] : undefined;
    if (ctx) {
      return {
        ...item,
        projects: [ctx.project],
        confidence: 0.98,
        classificationMethod: "rule",
        ...(ctx.engagement ? { engagement: ctx.engagement } : {}),
        ...(ctx.subBrand ? { subBrand: ctx.subBrand } : {}),
        ...(ctx.team ? { team: ctx.team } : {}),
      };
    }

    // Shorthand map — project only, no engagement context.
    const mapped = projectKey ? this.cfg.projectToCortex[projectKey] : undefined;
    if (mapped) {
      return {
        ...item,
        projects: [mapped],
        confidence: 0.95,
        classificationMethod: "rule",
      };
    }

    return { ...item, ...(await this.fallbackClassify(item, cctx, "")) };
  }

  private buildJql(since?: Date): string {
    const parts: string[] = [];
    if (this.cfg.projects.length > 0) {
      parts.push(`project in (${this.cfg.projects.map(escapeJql).join(", ")})`);
    }
    if (this.cfg.jql.trim()) parts.push(`(${this.cfg.jql.trim()})`);
    if (since) {
      parts.push(`updated >= "${formatJqlDate(since)}"`);
    }
    const body = parts.length > 0 ? parts.join(" AND ") : "ORDER BY updated DESC";
    return parts.length > 0 ? `${body} ORDER BY updated DESC` : body;
  }

  /**
   * Surface every Jira project the authed user can see. The wizard's
   * post-install hook stamps `{ jira_project_key: <KEY> }` into the
   * resulting projects.yaml entry.
   */
  async discoverProjects(): Promise<ProjectCandidate[]> {
    const candidates: ProjectCandidate[] = [];
    for await (const project of this.client.iterateProjects()) {
      candidates.push({
        slug: slugify(project.key),
        name: project.name || project.key,
        ...(project.description ? { description: project.description } : {}),
        sourceHints: { jira_project_key: project.key },
      });
    }
    return candidates;
  }
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";
}

function escapeJql(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function formatJqlDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const createAdapter: AdapterFactory = () => new JiraAdapter();
