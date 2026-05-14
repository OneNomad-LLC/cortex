import type { TranscriptSegment } from "./transcript.js";

/**
 * Thin abstraction over Loom's workspace API. The HTTP shape here
 * matches the generic pattern most Loom endpoints follow; the real
 * endpoint paths and field names may need adjustment once you're
 * authenticated against the current API version. That's the whole
 * point of wrapping it — the adapter's transform layer only sees the
 * normalized types below.
 */

export interface LoomClientOptions {
  apiKey: string;
  workspace: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
}

export interface LoomRecording {
  id: string;
  title: string;
  description?: string | null;
  url: string;
  folderId?: string | null;
  createdAt: string;
  updatedAt: string;
  durationSeconds?: number;
  owner?: { id?: string; name?: string; email?: string } | null;
  viewers?: Array<{ name?: string; email?: string }>;
  hasTranscript?: boolean;
}

export interface LoomTranscript {
  segments: TranscriptSegment[];
  language?: string;
}

interface PaginatedRecordings {
  results: LoomRecording[];
  nextCursor?: string | null;
}

export class LoomClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(private readonly opts: LoomClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.loom.com/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pageSize = Math.min(opts.pageSize ?? 50, 200);
  }

  /**
   * Iterate recordings newest-updated first. Stops at `sinceIso`. Folder
   * filters are applied client-side if the server ignores them so scoping
   * is always safe.
   */
  async *iterateRecordings(args: {
    folders?: string[];
    sinceIso?: string;
    maxRecordings?: number;
  }): AsyncIterable<LoomRecording> {
    let cursor: string | null = null;
    const cap = args.maxRecordings ?? 0;
    let emitted = 0;
    const since = args.sinceIso ? Date.parse(args.sinceIso) : undefined;
    const folderSet =
      args.folders && args.folders.length > 0 ? new Set(args.folders) : null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams();
      params.set("workspace", this.opts.workspace);
      params.set("limit", String(this.pageSize));
      if (cursor) params.set("cursor", cursor);

      const data: PaginatedRecordings = await this.get(
        `/recordings?${params.toString()}`,
      );

      for (const rec of data.results) {
        if (folderSet && rec.folderId && !folderSet.has(rec.folderId)) continue;
        if (since !== undefined && Date.parse(rec.updatedAt) <= since) return;
        yield rec;
        emitted++;
        if (cap > 0 && emitted >= cap) return;
      }
      if (!data.nextCursor) return;
      cursor = data.nextCursor;
    }
  }

  /**
   * Fetch the transcript for a recording. Returns `null` if the
   * recording has no transcript yet (still processing or unsupported).
   */
  async getTranscript(recordingId: string): Promise<LoomTranscript | null> {
    try {
      return await this.get<LoomTranscript>(
        `/recordings/${recordingId}/transcript`,
      );
    } catch (err) {
      if (err instanceof Error && /404/.test(err.message)) return null;
      throw err;
    }
  }

  private async get<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Loom ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
