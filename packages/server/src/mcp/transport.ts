import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "@onenomad/przm-cortex-core";
import { enterSession, runWithSession, setSessionToolAllowList } from "../session-context.js";
import { verifyCookie } from "../api/cookie-session.js";
import { verifyScopeToken } from "../api/scope-token.js";
import { expandScopes } from "@onenomad/przm-cortex-core";

export interface TransportHandle {
  kind: "stdio" | "http";
  close(): Promise<void>;
  /** Actual bound port (http only). */
  port?: number;
  /** Live session count for /api/status. */
  sessionCount?: () => number;
}

export interface ConnectTransportArgs {
  /**
   * Factory invoked once per HTTP session (and once for stdio). Each
   * call must produce a FRESH Server instance — the MCP SDK's Server
   * tracks `_initialized` per-instance and rejects a second `initialize`
   * on the same server, which is what made the old single-Server design
   * reject the second Claude client. See ADR-018 for the session-scoping
   * story; this factory is the transport-side half of that design.
   */
  buildMcp: () => Server;
  logger: Logger;
}

/**
 * Dispatch on PRZM_CORTEX_MCP_TRANSPORT (stdio | http).
 *
 * stdio (default): what Claude Code spawns as a subprocess.
 * http: used by containerized deployments — Cortex binds to a port and
 *   Claude Code connects via its MCP HTTP transport config. Pairs with
 *   the Docker/compose path (see docs/HOSTING.md).
 */
export async function connectConfiguredTransport(
  args: ConnectTransportArgs,
): Promise<TransportHandle> {
  const mode = (process.env.PRZM_CORTEX_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (mode === "http") return connectHttp(args);
  if (mode === "stdio") return connectStdio(args);
  throw new Error(
    `PRZM_CORTEX_MCP_TRANSPORT='${mode}' is not supported. Use 'stdio' or 'http'.`,
  );
}

async function connectStdio(
  args: ConnectTransportArgs,
): Promise<TransportHandle> {
  // One stdio transport = one Claude Code subprocess = one session for
  // the process lifetime. We bind a stable session id so session-aware
  // tools (get/set_session_workspace, taxonomy cache, workspace
  // helpers) work the same way they do under HTTP. ALS.enterWith makes
  // the context stick across the async boundaries inside the MCP SDK's
  // read loop — `runWithSession` won't, because we don't own the loop.
  const sessionId = `stdio-${randomUUID()}`;
  enterSession(sessionId);
  const mcp = args.buildMcp();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  args.logger.info("mcp.connected", { transport: "stdio", sessionId });
  return {
    kind: "stdio",
    async close() {
      await transport.close();
    },
  };
}

interface HttpSession {
  mcp: Server;
  transport: StreamableHTTPServerTransport;
}

async function connectHttp(
  args: ConnectTransportArgs,
): Promise<TransportHandle> {
  const port = Number(process.env.PRZM_CORTEX_MCP_PORT ?? "3100");
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`PRZM_CORTEX_MCP_PORT must be a number, got '${process.env.PRZM_CORTEX_MCP_PORT}'`);
  }
  const host = process.env.PRZM_CORTEX_MCP_HOST ?? "0.0.0.0";

  // Optional shared-secret auth. When PRZM_CORTEX_MCP_AUTH_TOKEN is set,
  // every HTTP request must carry `Authorization: Bearer <token>`.
  // The StreamableHTTP session id is a 128-bit randomUUID minted by
  // the SDK, but sessions are keyed in-memory and the header is
  // client-supplied on the wire — a bearer token is the cheap
  // defense when the MCP port is exposed beyond localhost. Use a
  // constant-time comparison so an attacker can't time-sidechannel
  // the valid token.
  const authToken = process.env.PRZM_CORTEX_MCP_AUTH_TOKEN;
  const gatewaySecret = process.env.PRZM_CORTEX_GATEWAY_SECRET;
  if (authToken && authToken.length < 16) {
    throw new Error(
      "PRZM_CORTEX_MCP_AUTH_TOKEN must be at least 16 chars of entropy. " +
        "Generate one with `openssl rand -hex 32`.",
    );
  }
  // Two-track auth, same shape as the dashboard API's gate. Either the
  // user-facing bearer (Claude Code, scripts) or the pyre-web gateway
  // secret passes. When neither env var is set, no gate (local dev).
  const constantTimeEq = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  };
  /**
   * Returns the per-request tool allow-list when the bearer is a
   * scoped JWT (cscope.<payload>.<sig>), or `undefined` for the
   * full-surface paths (cookie, gateway-secret, legacy opaque bearer).
   * The caller stamps `undefined` onto the session to mean "no
   * restriction" and a populated `Set<string>` to constrain
   * `tools/list` + `tools/call`.
   */
  const resolveAllowList = (
    req: import("node:http").IncomingMessage,
  ): Set<string> | undefined => {
    if (!gatewaySecret) return undefined;
    const authHeader = headerValue(req.headers["authorization"]);
    if (!authHeader) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) return undefined;
    const claims = verifyScopeToken(match[1]!.trim(), gatewaySecret);
    if (!claims) return undefined;
    return expandScopes(claims.scopes);
  };

  const authOk = (req: import("node:http").IncomingMessage): boolean => {
    if (!authToken && !gatewaySecret) return true;

    // Cookie session (browser handoff). Reuses the dashboard API's
    // cookie verifier so a user with a valid Cortex session cookie
    // can hit the MCP HTTP endpoint from a browser tab.
    if (verifyCookie(req)) return true;

    if (gatewaySecret) {
      const gw = headerValue(req.headers["x-cortex-gateway-secret"]);
      if (gw && constantTimeEq(gw, gatewaySecret)) return true;
    }

    // Scoped JWT bearer — verified signature passes auth. The actual
    // scope enforcement happens at tool-list / tool-call time via the
    // session's toolAllowList.
    if (gatewaySecret) {
      const authHeader = headerValue(req.headers["authorization"]);
      if (authHeader) {
        const match = /^Bearer\s+(.+)$/i.exec(authHeader);
        if (match && verifyScopeToken(match[1]!.trim(), gatewaySecret)) {
          return true;
        }
      }
    }

    if (authToken) {
      const header = headerValue(req.headers["authorization"]);
      if (header) {
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (match && constantTimeEq(match[1]!, authToken)) return true;
      }
    }

    return false;
  };

  // One Server + Transport pair PER MCP session. The StreamableHTTP
  // transport's internal `_initialized` flag is set on the first
  // initialize call, and the Server's own initialization state is
  // one-shot too — a second client would be rejected with
  // "Server already initialized." Keying both instances by session id
  // fixes concurrent-client support.
  const sessions = new Map<string, HttpSession>();

  // Factory — builds a fresh transport+server pair and wires up the
  // session lifecycle hooks so we can clean up when a client
  // disconnects.
  const createSession = async (): Promise<HttpSession> => {
    let sessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessionId = id;
        sessions.set(id, { mcp, transport });
        args.logger.info("mcp.session.initialized", {
          sessionId: id,
          live: sessions.size,
        });
      },
      onsessionclosed: (id: string) => {
        sessions.delete(id);
        args.logger.info("mcp.session.closed", {
          sessionId: id,
          live: sessions.size,
        });
      },
    });
    const mcp = args.buildMcp();
    // The SDK's Transport interface has a few narrowly-optional fields the
    // StreamableHTTP transport declares as `?:`, which trips
    // `exactOptionalPropertyTypes` at the `connect()` seam. Cast through
    // unknown — the shapes match at runtime.
    await mcp.connect(
      transport as unknown as Parameters<typeof mcp.connect>[0],
    );
    // Belt-and-suspenders cleanup: if the transport errors before the
    // onsessionclosed hook fires (network reset mid-stream, etc.),
    // drop the mapping so the next reconnect gets a fresh pair.
    transport.onerror = (err: Error) => {
      args.logger.warn("mcp.session.transport_error", {
        sessionId,
        error: err.message,
      });
      if (sessionId) sessions.delete(sessionId);
    };
    return { mcp, transport };
  };

  const httpServer: HttpServer = createServer((req, res) => {
    void dispatch(req, res).catch((err) => {
      args.logger.warn("mcp.http.handler_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  const dispatch = async (
    req: Parameters<typeof httpServer.listeners>[0] extends unknown
      ? import("node:http").IncomingMessage
      : never,
    res: import("node:http").ServerResponse,
  ): Promise<void> => {
    if (!authOk(req)) {
      args.logger.warn("mcp.http.auth_rejected", {
        ip: req.socket.remoteAddress ?? "unknown",
      });
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end("unauthorized");
      return;
    }
    // Resolve scope claims once per request. The session that picks
    // up this auth gets stamped with the resulting allow-list (or
    // cleared when the request used a non-scoped credential, so an
    // earlier scoped session can't poison a later unscoped one on
    // the same session id).
    const allowList = resolveAllowList(req);
    const headerId = headerValue(req.headers["mcp-session-id"]);
    // Existing session — route to the live transport.
    if (headerId && sessions.has(headerId)) {
      setSessionToolAllowList(headerId, allowList);
      const session = sessions.get(headerId)!;
      runWithSession(headerId, () => {
        void session.transport.handleRequest(req, res).catch((err) => {
          args.logger.warn("mcp.http.dispatch_failed", {
            sessionId: headerId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
      return;
    }
    // Missing / unknown session id on anything other than a POST
    // (which is where initialize lives). The SDK will return its own
    // 400/404 explaining the client needs to initialize first.
    // We still build a fresh transport — otherwise the SDK can't
    // generate the session id to hand back in the 404 response.
    const session = await createSession();
    // Provisional session id for the ALS wrapper; real id is assigned
    // by the transport and stashed in `sessions` via
    // onsessioninitialized.
    const tempId = headerId ?? randomUUID();
    setSessionToolAllowList(tempId, allowList);
    runWithSession(tempId, () => {
      void session.transport.handleRequest(req, res).catch((err) => {
        args.logger.warn("mcp.http.initialize_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  };

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
    sessionCount: () => sessions.size,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await Promise.all(
        [...sessions.values()].map((s) => s.transport.close().catch(() => undefined)),
      );
      sessions.clear();
    },
  };
}

function headerValue(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0];
  }
  return undefined;
}
