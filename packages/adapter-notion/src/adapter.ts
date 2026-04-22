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
import { blocksToMarkdown, type NotionBlock } from "./blocks.js";
import { NotionClient, type NotionPage } from "./client.js";

export const notionConfigSchema = z.object({
  /** Database ids to sync (every page in them). */
  databases: z.array(z.string().min(1)).default([]),
  /** Additional standalone page ids to include (e.g., hub pages). */
  pages: z.array(z.string().min(1)).default([]),
  pageSize: z.number().int().min(1).max(100).default(50),
  maxPagesPerRun: z.number().int().min(0).default(0),
  /** Map Notion database id → Cortex project slug. */
  databaseToProject: z.record(z.string()).default({}),
  /** Fallback project slug when nothing matches. Empty = unclassified. */
  defaultProject: z.string().default(""),
});

export type NotionConfig = z.infer<typeof notionConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false,
  supportsAttachments: true,
  supportsComments: false,
  supportsRealTime: false,
};

interface RawNotionPage {
  page: NotionPage;
  blocks: NotionBlock[];
  sourceDatabaseId?: string;
}

export class NotionAdapter extends BaseAdapter {
  readonly id = "notion";
  readonly name = "Notion";
  readonly version = "0.1.0";
  readonly configSchema = notionConfigSchema;
  readonly requiredSecrets = ["NOTION_API_KEY"] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@cortex/pipeline-doc"] as const;

  private client!: NotionClient;
  private cfg!: NotionConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const apiKey = this.ctx.secrets.NOTION_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("notion adapter: NOTION_API_KEY must be set");
    }
    this.client = new NotionClient({ apiKey, pageSize: this.cfg.pageSize });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    if (this.cfg.databases.length > 0 && this.cfg.databases[0]) {
      const it = this.client.iterateDatabase({
        databaseId: this.cfg.databases[0],
        maxPages: 1,
      });
      for await (const _p of it) break;
      return { reachable: true };
    }
    if (this.cfg.pages.length > 0 && this.cfg.pages[0]) {
      await this.client.getPage(this.cfg.pages[0]);
      return { reachable: true };
    }
    throw new Error(
      "notion adapter: configure at least one `databases` or `pages` id",
    );
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const sinceIso = since?.toISOString();
    const budgetTotal = this.cfg.maxPagesPerRun;
    let remaining = budgetTotal > 0 ? budgetTotal : Infinity;

    for (const databaseId of this.cfg.databases) {
      if (remaining <= 0) break;
      const it = this.client.iterateDatabase({
        databaseId,
        ...(sinceIso ? { sinceIso } : {}),
        maxPages: Number.isFinite(remaining) ? (remaining as number) : 0,
      });
      for await (const page of it) {
        const blocks = await this.client.getBlockTree(page.id);
        remaining -= 1;
        yield {
          sourceId: `notion:page:${page.id}`,
          raw: { page, blocks, sourceDatabaseId: databaseId },
        };
        if (remaining <= 0) break;
      }
    }

    for (const pageId of this.cfg.pages) {
      if (remaining <= 0) break;
      const page = await this.client.getPage(pageId);
      if (sinceIso && Date.parse(page.last_edited_time) <= Date.parse(sinceIso)) {
        continue;
      }
      const blocks = await this.client.getBlockTree(pageId);
      remaining -= 1;
      yield {
        sourceId: `notion:page:${page.id}`,
        raw: { page, blocks },
      };
    }

    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const payload = raw.raw as RawNotionPage;
    const { page, blocks, sourceDatabaseId } = payload;
    const title = extractTitle(page) || "Untitled";
    const body = blocksToMarkdown(blocks);
    const content = `# ${title}\n\n${body}`.trim();

    return {
      sourceId: raw.sourceId,
      sourceType: "notion",
      sourceUrl: page.url,
      title,
      content,
      contentType: "doc",
      createdAt: new Date(page.created_time),
      updatedAt: new Date(page.last_edited_time),
      authors: [],
      ...(page.parent.page_id ? { parentId: page.parent.page_id } : {}),
      rawMetadata: {
        pageId: page.id,
        parentType: page.parent.type,
        databaseId: sourceDatabaseId ?? page.parent.database_id,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    _ctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const dbId = item.rawMetadata.databaseId as string | undefined;
    const mapped = dbId ? this.cfg.databaseToProject[dbId] : undefined;
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
    return {
      ...item,
      projects: [],
      confidence: 0,
      classificationMethod: "rule",
    };
  }
}

/** Pull the title out of a page's properties. Notion stores it under
 *  whichever property has type="title", usually but not always "Name". */
function extractTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text).join("").trim();
    }
  }
  return "";
}

export const createAdapter: AdapterFactory = () => new NotionAdapter();
