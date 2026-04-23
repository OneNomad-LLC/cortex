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

export const googleDriveConfigSchema = z.object({
  /** Drive folder ids to scan. Files in subfolders are included too. */
  folderIds: z.array(z.string().min(1)).default([]),
  /** Mime types to include. Default: Google Docs only. */
  mimeTypes: z
    .array(z.string().min(1))
    .default(["application/vnd.google-apps.document"]),
  pageSize: z.number().int().min(1).max(1000).default(100),
  maxFilesPerRun: z.number().int().min(0).default(0),
  /** Map Drive folder id → Cortex project slug. */
  folderToProject: z.record(z.string()).default({}),
  defaultProject: z.string().default(""),
});

export type GoogleDriveConfig = z.infer<typeof googleDriveConfigSchema>;

const SCOPES = ["https://www.googleapis.com/auth/drive.readonly"] as const;

const CAPABILITIES: AdapterCapabilities = {
  supportsIncrementalSync: true,
  supportsWebhooks: false,
  supportsAttachments: false,
  supportsComments: false,
  supportsRealTime: false,
};

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  createdTime: string;
  modifiedTime: string;
  parents?: string[];
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  trashed?: boolean;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface RawDriveItem {
  file: DriveFile;
  topFolderId: string;
  body: string;
}

export class GoogleDriveAdapter extends BaseAdapter {
  readonly id = "google-drive";
  readonly name = "Google Drive";
  readonly version = "0.1.0";
  readonly configSchema = googleDriveConfigSchema;
  readonly requiredSecrets = [] as const;
  readonly capabilities = CAPABILITIES;
  readonly pipelines = ["@onenomad/cortex-pipeline-doc"] as const;

  private auth!: GoogleAuthClient;
  private cfg!: GoogleDriveConfig;

  protected override async onInit(): Promise<void> {
    this.cfg = this.configSchema.parse(this.ctx.config);
    const token = await readGoogleToken();
    this.auth = new GoogleAuthClient({ token });
    if (!this.auth.hasAllScopes(SCOPES)) {
      this.ctx.logger.warn("google-drive.scope_missing", {
        required: SCOPES,
        have: this.auth.scopes,
      });
    }
    if (this.cfg.folderIds.length === 0) {
      throw new Error(
        "google-drive adapter: folderIds must be non-empty (safer than scanning your entire Drive)",
      );
    }
  }

  protected override async probeHealth(): Promise<Record<string, unknown>> {
    const first = this.cfg.folderIds[0]!;
    await this.listChildren(first, 1);
    return { folders: this.cfg.folderIds.length };
  }

  async *fetch(since?: Date): AsyncIterable<RawSourceItem> {
    const sinceIso = since?.toISOString();
    let remaining =
      this.cfg.maxFilesPerRun > 0 ? this.cfg.maxFilesPerRun : Infinity;

    for (const topFolderId of this.cfg.folderIds) {
      if (remaining <= 0) break;
      const walker = this.walk(topFolderId, sinceIso);
      for await (const file of walker) {
        if (remaining <= 0) break;
        if (!this.cfg.mimeTypes.includes(file.mimeType)) continue;
        const body = await this.exportAsMarkdown(file).catch((err) => {
          this.ctx.logger.warn("google-drive.export_failed", {
            fileId: file.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        if (body === null) continue;
        remaining -= 1;
        yield {
          sourceId: `google-drive:file:${file.id}`,
          raw: { file, topFolderId, body } satisfies RawDriveItem,
        };
      }
    }
    this.markSuccess();
  }

  async transform(raw: RawSourceItem): Promise<NormalizedItem> {
    const item = raw.raw as RawDriveItem;
    const { file, body } = item;
    const authors = (file.owners ?? [])
      .map((o) => o.emailAddress)
      .filter((e): e is string => typeof e === "string");
    return {
      sourceId: raw.sourceId,
      sourceType: "google_drive",
      sourceUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}`,
      title: file.name,
      content: body,
      contentType: "doc",
      createdAt: new Date(file.createdTime),
      updatedAt: new Date(file.modifiedTime),
      authors,
      rawMetadata: {
        fileId: file.id,
        mimeType: file.mimeType,
        parents: file.parents ?? [],
        topFolderId: item.topFolderId,
      },
    };
  }

  async classify(
    item: NormalizedItem,
    cctx: ClassificationContext,
  ): Promise<ClassifiedItem> {
    const topFolderId = item.rawMetadata.topFolderId as string | undefined;
    const mapped = topFolderId ? this.cfg.folderToProject[topFolderId] : undefined;
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

  /**
   * Recursively walk a folder tree. Yields leaf files (not folders).
   * Google Drive has no server-side since filter for folder listings,
   * so we filter client-side by `modifiedTime`.
   */
  private async *walk(
    folderId: string,
    sinceIso: string | undefined,
  ): AsyncIterable<DriveFile> {
    const stack = [folderId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for await (const file of this.listChildrenGen(current)) {
        if (file.trashed) continue;
        if (
          sinceIso &&
          file.modifiedTime &&
          Date.parse(file.modifiedTime) <= Date.parse(sinceIso)
        ) {
          continue;
        }
        if (file.mimeType === "application/vnd.google-apps.folder") {
          stack.push(file.id);
          continue;
        }
        yield file;
      }
    }
  }

  private async *listChildrenGen(
    folderId: string,
  ): AsyncIterable<DriveFile> {
    let pageToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        pageSize: String(this.cfg.pageSize),
        fields:
          "nextPageToken, files(id, name, mimeType, webViewLink, createdTime, modifiedTime, parents, owners(emailAddress, displayName), trashed)",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.auth.authorizedFetch<DriveListResponse>(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      );
      for (const f of data.files ?? []) yield f;
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  }

  private async listChildren(
    folderId: string,
    limit: number,
  ): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    for await (const f of this.listChildrenGen(folderId)) {
      out.push(f);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Export a Google Doc (or similar) to markdown via the export endpoint. */
  private async exportAsMarkdown(file: DriveFile): Promise<string> {
    if (file.mimeType !== "application/vnd.google-apps.document") {
      // For non-Docs, fall back to the raw download. Non-prose types
      // shouldn't be here because the mimeTypes filter excludes them,
      // but this is a safe path if a user widens the filter.
      const auth = await this.auth.authorization();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
        { headers: { authorization: auth } },
      );
      if (!res.ok) throw new Error(`drive raw download ${res.status}`);
      return (await res.text()).trim();
    }

    const auth = await this.auth.authorization();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/markdown`,
      { headers: { authorization: auth } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `drive export ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    return (await res.text()).trim();
  }
}

export const createAdapter: AdapterFactory = () => new GoogleDriveAdapter();
