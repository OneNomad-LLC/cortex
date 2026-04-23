import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "@onenomad/cortex-core";
import type {
  EngramMemory,
  EngramSearchArgs,
  HealthStatus,
  RemoteEngramClient,
} from "./types.js";

export interface RemoteEngramClientOptions {
  /**
   * Caller-visible slug for this backend — e.g. `team-alpha`. Stamped on
   * every memory returned by `search` as `_backend`, so a federated
   * wrapper can attribute rows.
   */
  slug: string;
  /**
   * Full URL to the Engram HTTP MCP endpoint, e.g.
   * `https://memory.example.com/mcp`.
   */
  url: string;
  /**
   * Called on every outgoing request; returns headers to merge into the
   * request. Use this for bearer tokens or signed requests. Returning
   * an empty record is fine for public/unauthenticated backends.
   */
  authorization?(): Promise<Record<string, string>> | Record<string, string>;
  /**
   * Test/dev injection point. Defaults to the global `fetch`.
   */
  fetch?: FetchLike;
  logger: Logger;
}

/**
 * Remote Engram client over HTTP MCP. Thin twin of the stdio client
 * in `packages/server/src/clients/engram.ts` — same tool calls
 * (`memory_ingest`, `memory_search`, `memory_stats`), same return
 * shape.
 *
 * This is a v1 skeleton per ADR-016. Score merging, timeout budgets,
 * and federated fan-out live in the server package's federation
 * wrapper (to be added when the first real remote deploys).
 */
export async function createRemoteEngramClient(
  opts: RemoteEngramClientOptions,
): Promise<RemoteEngramClient> {
  const url = new URL(opts.url);
  const authFn = opts.authorization;

  // Wrap fetch to inject auth headers on every call. The SDK gives us
  // one `requestInit` at construction time, but auth tokens may be
  // short-lived — folding auth into the fetch closure keeps the refresh
  // responsibility on the caller.
  const baseFetch: FetchLike = opts.fetch ?? (globalThis.fetch as FetchLike);
  const authedFetch: FetchLike = async (input, init) => {
    const extra = authFn ? await authFn() : {};
    const merged: RequestInit = {
      ...(init ?? {}),
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        ...extra,
      },
    };
    return baseFetch(input, merged);
  };

  const transport = new StreamableHTTPClientTransport(url, {
    fetch: authedFetch,
  });

  const client = new Client(
    { name: "cortex-memory-remote", version: "0.0.0" },
    { capabilities: {} },
  );
  // SDK types declare sessionId as required; the concrete transport marks
  // it optional until the server hands one back. Cast so strict optional
  // property checking doesn't reject the connect call.
  await client.connect(transport as unknown as Transport);
  opts.logger.info("memory_remote.connected", {
    slug: opts.slug,
    host: url.host,
  });

  let lastSuccessAt: number | undefined;

  return {
    async ingest(input) {
      const res = await callTool<{ id?: string } | string>(
        client,
        "memory_ingest",
        {
          content: input.content,
          metadata: input.metadata,
        },
      );
      lastSuccessAt = Date.now();
      const id =
        typeof res === "object" && res && "id" in res
          ? ((res as { id: string }).id ?? "")
          : "";
      return { id };
    },

    async search(args: EngramSearchArgs): Promise<EngramMemory[]> {
      const payload: Record<string, unknown> = {
        query: args.query,
        limit: args.limit ?? 10,
        domain: args.domain ?? "work",
      };
      const filters: Record<string, unknown> = {};
      if (args.project) filters.project = args.project;
      if (args.type) filters.type = args.type;
      if (args.source) filters.source = args.source;
      if (args.sinceIso) filters.since = args.sinceIso;
      if (Object.keys(filters).length > 0) payload.filters = filters;

      const res = await callTool<
        { memories?: EngramMemory[] } | EngramMemory[]
      >(client, "memory_search", payload);
      lastSuccessAt = Date.now();

      const raw = Array.isArray(res) ? res : (res?.memories ?? []);
      // Stamp backend slug so the federated wrapper can show provenance.
      return raw.map((m) => ({ ...m, _backend: opts.slug }));
    },

    async healthCheck(): Promise<HealthStatus> {
      try {
        const stats = await callTool<Record<string, unknown>>(
          client,
          "memory_stats",
          {},
        );
        lastSuccessAt = Date.now();
        return {
          healthy: true,
          message: "",
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
          details: stats ?? {},
        };
      } catch (err) {
        opts.logger.warn("memory_remote.healthcheck.failed", {
          slug: opts.slug,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          healthy: false,
          message: err instanceof Error ? err.message : String(err),
          ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
        };
      }
    },

    async shutdown() {
      try {
        await client.close();
      } catch (err) {
        opts.logger.warn("memory_remote.close.failed", {
          slug: opts.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/**
 * Thin wrapper over `client.callTool` that extracts the first JSON
 * content block. Mirrors `callJsonTool` in the stdio client so the
 * two implementations stay in lock-step on response handling.
 */
async function callTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  if (res.isError) {
    const msg = res.content
      .map((c) => ("text" in c ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    throw new Error(msg || `tool ${name} returned isError`);
  }
  for (const block of res.content ?? []) {
    if (block.type === "text") {
      const text = (block as { text: string }).text;
      try {
        return JSON.parse(text) as T;
      } catch {
        // Not JSON — surface the raw text so callers can decide.
        return text as unknown as T;
      }
    }
  }
  return undefined as unknown as T;
}
