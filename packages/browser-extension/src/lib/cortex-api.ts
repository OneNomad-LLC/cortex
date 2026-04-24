import type { CortexSource, CortexType } from "./types";

export interface IngestInput {
  content: string;
  project: string;
  type?: CortexType;
  sourceId: string;
  title?: string;
  sourceUrl?: string;
  tags?: string[];
  /** Maps to SourceType on the server. */
  source?: CortexSource;
}

export interface IngestResult {
  ok: boolean;
  error?: string;
  memories?: unknown[];
  count?: number;
}

/** Loose shape of the `ProjectRow` list_projects returns. */
export interface CortexProject {
  slug: string;
  name: string;
  description: string;
  active: boolean;
  aliases: string[];
  people: string[];
}

interface McpInvokeResponse<T = unknown> {
  result?: T;
  error?: string;
  elapsedMs?: number;
  traceId?: string;
}

interface IngestToolResult {
  ingested: number;
  sourceId: string;
  project: string;
  type: string;
  memories?: unknown[];
}

interface ListProjectsToolResult {
  projects?: CortexProject[];
}

/**
 * POST to the MCP-tool invoke endpoint the dashboard API exposes.
 * The server wraps the tool output in { result, elapsedMs, traceId }
 * on success or { error } on failure; we normalize into IngestResult.
 */
export async function ingestToCortex(
  apiBase: string,
  input: IngestInput,
): Promise<IngestResult> {
  const url = `${stripTrailingSlash(apiBase)}/api/mcp/tools/ingest_content/invoke`;
  // Build the payload lazily so we don't send empty strings the server
  // would have to re-default on parse. The Zod schema does default
  // everything, but explicit is friendlier to debug.
  const payload: Record<string, unknown> = {
    content: input.content,
    project: input.project,
    sourceId: input.sourceId,
  };
  if (input.type) payload.type = input.type;
  if (input.title) payload.title = input.title;
  if (input.sourceUrl) payload.sourceUrl = input.sourceUrl;
  if (input.source) payload.source = input.source;
  if (input.tags && input.tags.length > 0) payload.tags = input.tags;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cortex-source": "browser-extension",
      },
      body: JSON.stringify({ input: payload }),
    });
    const json = (await resp.json().catch(() => ({}))) as McpInvokeResponse<
      IngestToolResult
    >;
    if (!resp.ok || json.error) {
      return {
        ok: false,
        error:
          json.error ?? `HTTP ${resp.status} ${resp.statusText}`,
      };
    }
    const result = json.result;
    const memories = result?.memories;
    const out: IngestResult = {
      ok: true,
      count: result?.ingested ?? 0,
    };
    if (Array.isArray(memories)) {
      out.memories = memories;
    }
    return out;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch the project taxonomy via the list_projects MCP tool. Returns
 * an empty array on any failure — the popup treats projects as an
 * editable combobox, so a failed fetch shouldn't block ingestion.
 */
export async function fetchProjects(apiBase: string): Promise<CortexProject[]> {
  const url = `${stripTrailingSlash(apiBase)}/api/mcp/tools/list_projects/invoke`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cortex-source": "browser-extension",
      },
      body: JSON.stringify({ input: { activeOnly: true } }),
    });
    if (!resp.ok) return [];
    const json = (await resp.json().catch(() => ({}))) as McpInvokeResponse<
      ListProjectsToolResult
    >;
    return json.result?.projects ?? [];
  } catch {
    return [];
  }
}

/**
 * Cheap reachability check used by the popup's status dot. `/health`
 * is a single-line JSON that always answers on a bound dashboard API.
 */
export async function pingCortex(apiBase: string): Promise<boolean> {
  try {
    const resp = await fetch(`${stripTrailingSlash(apiBase)}/health`, {
      method: "GET",
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
