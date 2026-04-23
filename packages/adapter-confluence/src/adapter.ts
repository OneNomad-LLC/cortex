import { z } from "zod";
import type {
  AdapterCapabilities,
  AdapterContext,
  AdapterFactory,
  ClassificationContext,
  ClassifiedItem,
  HealthStatus,
  NormalizedItem,
  ProjectCandidate,
  RawSourceItem,
} from "@onenomad/cortex-core";
import { BaseAdapter } from "@onenomad/cortex-adapter-sdk";
import { ConfluenceClient, type ConfluencePageFull } from "./client.js";
import { storageToMarkdown } from "./storage.js";

/** Full engagement/sub-brand/project tuple for a single space. */
export const spaceContextSchema = z.object({
  /** Engagement slug — maps to the `engagement:*` domain and engagements.yaml. */
  engagement: z.string().min(1).optional(),
  /** Sub-brand slug within the engagement (e.g. "jiffy-lube"). */
  subBrand: z.string().min(1).optional(),
  /** Project slug — same meaning as projects.yaml; becomes the `project` metadata field. */
  project: z.string().min(1),
  /** Dev team slug if the space is owned by a specific team. */
  team: z.string().min(1).optional(),
});

export type SpaceContext = z.infer<typeof spaceContextSchema>;

export const confluenceConfigSchema = z.object({
  /** The `<subdomain>.atlassian.net` subdomain only. */
  workspace: z.string().min(1),
  /** Space keys to sync. Empty = all visible spaces. */
  spaces: z.array(z.string().min(1)).default([]),
  pageSize: z.number().int().min(1).max(250).default(50),
  /** Max pages per sync run per space. 0 = unlimited. */
  maxPagesPerRun: z.number().int().min(0).default(0),
  /**
   * Shorthand classifier: space key -> project slug. Used when the only
   * context that matters is the Cortex project. Kept for simple setups
   * and back-compat; pairs with `spaceToContext` for richer mappings.
   */
  spaceToProject: z.record(z.string()).default({}),
  /**
   * Rich classifier: space key -> full context tuple
   * `{engagement, subBrand, project, team}`. When present, fields are
   * stamped onto every memory emitted from that space. Falls back to
   * `spaceToProject` if a space isn't in this map.
   */
  spaceToContext: z.record(spaceContextSchema).default({}),
});

export type ConfluenceConfig = z.infer<typeof confluenceConfigSchema>;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false, // Atlassian Cloud supports these; not wired yet.
  supportsAttachments: true,
  supportsComments: true,
  supportsRealTime: false,
};

interface RawConfluencePage {
  page: ConfluencePageFull;
  spaceKey: string | undefined;
  authorEmail?: string;
}

/**
 * Confluence source adapter. Yields pages from configured spaces, turns
 * storage-format XHTML into markdown, and tags by space using either a
 * rule-based map or a fallback LLM classifier (deferred).
 *
 * Declares `@onenomad/cortex-pipeline-doc` so the server routes its output through
 * doc chunking before ingestion.
 */
export class ConfluenceAdapter extends BaseAdapter {
  readonly id = "confluence";
  readonly name = "Confluence";
  readonly version = "0.1.0";
  readonly configSchema = confluenceConfigSchema;
  readonly requiredSecrets = [
    "ATLASSIAN_EMAIL",
    "ATLASSIAN_API_TOKEN",
  ] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/cortex-pipeline-doc"] as const;

  private client!: ConfluenceClient;
  private cfg!: ConfluenceConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const email = this.ctx.secrets.ATLASSIAN_EMAIL ?? "";
    const apiToken = this.ctx.secrets.ATLASSIAN_API_TOKEN ?? "";
    if (!email || !apiToken) {
      throw new Error(
        "confluence adapter: ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN must be set",
      );
    }
    this.client = new ConfluenceClient({
      workspace: this.cfg.workspace,
      email,
      apiToken,
      pageSize: this.cfg.pageSize,
    });
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    // Listing spaces is the cheapest call that proves auth + reachability.
    const spaces = await this.client.listSpaces(
      this.cfg.spaces.length > 0 ? this.cfg.spaces : undefined,
    );
    return { spaceCount: spaces.length };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const allSpaces = await this.client.listSpaces(
      this.cfg.spaces.length > 0 ? this.cfg.spaces : undefined,
    );
    const spaceById = new Map(allSpaces.map((s) => [s.id, s]));

    for (const space of allSpaces) {
      const iter = this.client.iteratePages({
        spaceId: space.id,
        ...(since ? { sinceIso: since.toISOString() } : {}),
        maxPages: this.cfg.maxPagesPerRun,
      });

      for await (const summary of iter) {
        const full = await this.client.getPage(summary.id, "storage");
        const spaceKey = spaceById.get(full.spaceId)?.key;
        const raw: RawConfluencePage = { page: full, spaceKey };
        yield { sourceId: `confluence:page:${full.id}`, raw };
      }
    }

    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const payload = raw.raw as RawConfluencePage;
    const { page } = payload;
    const storage = page.body?.storage?.value ?? "";
    const content = storageToMarkdown(storage);
    const created = page.createdAt ?? page.version?.createdAt ?? new Date().toISOString();
    const updated = page.version?.createdAt ?? created;

    return {
      sourceId: raw.sourceId,
      sourceType: "confluence",
      sourceUrl: this.client.pageUrl(page),
      title: page.title,
      content,
      contentType: "doc",
      createdAt: new Date(created),
      updatedAt: new Date(updated),
      authors: [], // Resolve via people.yaml in a future enhancement.
      ...(page.parentId ? { parentId: page.parentId } : {}),
      rawMetadata: {
        pageId: page.id,
        spaceId: page.spaceId,
        spaceKey: payload.spaceKey,
        version: page.version?.number,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const spaceKey =
      (item.rawMetadata.spaceKey as string | undefined) ?? undefined;

    // Rich mapping wins — carries the full engagement/sub-brand/team tuple.
    const ctx = spaceKey ? this.cfg.spaceToContext[spaceKey] : undefined;
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
    const mapped = spaceKey ? this.cfg.spaceToProject[spaceKey] : undefined;
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

  /**
   * Surface every Confluence space the authed user can read as a
   * project candidate. The wizard's post-install hook writes each
   * pick into projects.yaml with `confluence_space: <key>` so the
   * Confluence adapter can route future syncs by space key.
   */
  async discoverProjects(): Promise<ProjectCandidate[]> {
    const candidates: ProjectCandidate[] = [];
    for await (const space of this.client.iterateAllSpaces()) {
      // Skip personal-user spaces — they aren't shared projects.
      if (space.type === "personal") continue;
      candidates.push({
        slug: slugify(space.key),
        name: space.name || space.key,
        sourceHints: { confluence_space: space.key },
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
    .slice(0, 60) || "space";
}

export const createAdapter: AdapterFactory = () => new ConfluenceAdapter();
