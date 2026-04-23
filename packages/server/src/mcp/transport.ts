import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "@onenomad/cortex-core";

export interface TransportHandle {
  kind: "stdio" | "http";
  close(): Promise<void>;
  /** Actual bound port (http only). */
  port?: number;
}

export interface ConnectTransportArgs {
  mcp: Server;
  logger: Logger;
}

/**
 * Dispatch on CORTEX_MCP_TRANSPORT (stdio | http).
 *
 * stdio (default): what Claude Code spawns as a subprocess.
 * http: used by containerized deployments — Cortex binds to a port and
 *   Claude Code connects via its MCP HTTP transport config. Pairs with
 *   the Docker/compose path (see docs/HOSTING.md).
 */
export async function connectConfiguredTransport(
  args: ConnectTransportArgs,
): Promise<TransportHandle> {
  const mode = (process.env.CORTEX_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (mode === "http") return connectHttp(args);
  if (mode === "stdio") return connectStdio(args);
  throw new Error(
    `CORTEX_MCP_TRANSPORT='${mode}' is not supported. Use 'stdio' or 'http'.`,
  );
}

async function connectStdio(
  args: ConnectTransportArgs,
): Promise<TransportHandle> {
  const transport = new StdioServerTransport();
  await args.mcp.connect(transport);
  args.logger.info("mcp.connected", { transport: "stdio" });
  return {
    kind: "stdio",
    async close() {
      await transport.close();
    },
  };
}

async function connectHttp(
  args: ConnectTransportArgs,
): Promise<TransportHandle> {
  const port = Number(process.env.CORTEX_MCP_PORT ?? "3100");
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`CORTEX_MCP_PORT must be a number, got '${process.env.CORTEX_MCP_PORT}'`);
  }
  const host = process.env.CORTEX_MCP_HOST ?? "0.0.0.0";
  // Stateful session ids — each new client gets a uuid that the SDK
  // attaches to responses and requires on subsequent calls. Stateless
  // mode is possible but loses the ability to stream incremental
  // responses across a multi-step tool call.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  // The SDK's Transport interface has a few narrowly-optional fields the
  // StreamableHTTP transport declares as `?:`, which trips
  // `exactOptionalPropertyTypes` at the `connect()` seam. Cast through
  // unknown — the shapes match at runtime.
  await args.mcp.connect(transport as unknown as Parameters<typeof args.mcp.connect>[0]);

  const httpServer: HttpServer = createServer((req, res) => {
    // The SDK parses the request body itself, but we read it first to
    // support non-JSON edge cases (health probes, favicon hits). For MCP
    // calls the transport expects raw request/response and handles
    // everything — we just forward.
    void transport.handleRequest(req, res).catch((err) => {
      args.logger.warn("mcp.http.handler_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  const bound = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      resolve(addr && typeof addr === "object" ? addr.port : port);
    });
  });
  args.logger.info("mcp.connected", {
    transport: "http",
    host,
    port: bound,
  });

  return {
    kind: "http",
    port: bound,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await transport.close();
    },
  };
}
