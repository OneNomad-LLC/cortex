import { loadCredentials } from "./credentials.js";
import { startServer } from "../mcp/server.js";

/**
 * `cortex serve` — single entry point that does the right thing for
 * either mode. Cloud mode: stdio MCP server that proxies every
 * request to the configured remote streamable-HTTP MCP. Local mode:
 * delegates to the existing `startServer()` boot path, which already
 * defaults to stdio when no transport env var is set.
 *
 * The intended use is `claude mcp add cortex cortex -- serve` — once
 * configured, the same shell command transparently follows whichever
 * mode `cortex use ...` last selected.
 */
export async function runServe(_args: string[]): Promise<number> {
  const creds = await loadCredentials();
  if (creds.mode === "local") {
    // Local: hand off to the existing server boot. Honors the stdio
    // default unless CORTEX_MCP_TRANSPORT overrides.
    await startServer();
    return 0;
  }
  if (!creds.mcpUrl || !creds.bearer) {
    process.stderr.write(
      `cortex serve: mode=cloud but credentials are incomplete.\n` +
        `Run \`cortex login\` to refresh, or set CORTEX_MCP_URL + CORTEX_MCP_TOKEN.\n`,
    );
    return 1;
  }
  await runCloudProxy({ remoteUrl: creds.mcpUrl, bearer: creds.bearer });
  return 0;
}

/**
 * Bidirectional bridge between the local stdio MCP transport (what
 * Claude Code / Cursor / Cline spawn us as) and the remote
 * streamable-HTTP MCP transport (Cortex Cloud).
 *
 * We use the MCP SDK's own transports so the JSON-RPC framing,
 * session-id propagation, and notification fan-out are handled
 * correctly. The client transport (HTTP) drives the upstream; the
 * server transport (stdio) drives the local stdin/stdout. A `Client`
 * + `Server` pair wire them together: incoming tool calls on stdio
 * forward to the upstream; responses + notifications stream back.
 */
async function runCloudProxy(opts: {
  remoteUrl: string;
  bearer: string;
}): Promise<void> {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  type Transport = Parameters<InstanceType<typeof Client>["connect"]>[0];

  // Upstream client — talks to Cortex Cloud over HTTP with bearer.
  const upstream = new Client(
    { name: "cortex-cli-proxy", version: "0.4.0" },
    { capabilities: {} },
  );
  const upstreamTransport = new StreamableHTTPClientTransport(
    new URL(opts.remoteUrl),
    {
      requestInit: {
        headers: { authorization: `Bearer ${opts.bearer}` },
      },
    },
  );
  // SDK 1.29 declares Transport.sessionId as `sessionId?: string` (optional,
  // non-undefined) while the concrete transport exposes
  // `get sessionId(): string | undefined`. Under exactOptionalPropertyTypes
  // that combination is structurally rejected even though every runtime
  // path works. Coerce at the SDK boundary; the alternative is forking
  // the SDK's d.ts. Tracked upstream.
  await upstream.connect(upstreamTransport as unknown as Transport);

  // Mirror upstream's advertised capabilities + instructions so the
  // local client (Claude Code, etc.) sees Cortex Cloud's full surface
  // — not a degraded view shaped by what the proxy thinks it knows.
  const serverInfo = upstream.getServerVersion() ?? {
    name: "cortex",
    version: "unknown",
  };
  const capabilities = upstream.getServerCapabilities() ?? {};
  const instructions = upstream.getInstructions();
  const local = new Server(serverInfo, {
    capabilities,
    ...(instructions ? { instructions } : {}),
  });

  // Generic request forwarder: every method the local server receives
  // gets re-issued to the upstream client. We don't enumerate the MCP
  // method surface — that would couple the proxy to the SDK version
  // and break the moment Cortex adds a new tool category.
  local.fallbackRequestHandler = async (request) => {
    return upstream.request(request, undefined as never, undefined);
  };
  // Notifications flow both ways. Upstream → local (server-initiated
  // events like resource updates) and local → upstream (initialized,
  // progress, etc.).
  local.fallbackNotificationHandler = async (notification) => {
    await upstream.notification(notification);
  };
  upstream.fallbackNotificationHandler = async (notification) => {
    await local.notification(notification);
  };

  const stdio = new StdioServerTransport();
  await local.connect(stdio);

  // Clean shutdown so the parent (Claude Code) sees stdin EOF land
  // immediately when we go down. Without this, the parent waits for
  // the OS to reap the orphaned HTTP connection.
  const shutdown = async (): Promise<never> => {
    try {
      await Promise.allSettled([local.close(), upstream.close()]);
    } finally {
      process.exit(0);
    }
    // typescript narrowing — exit() never returns
    return undefined as never;
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // When stdin EOFs (parent closed us), tear down upstream too.
  process.stdin.on("end", () => void shutdown());
}
