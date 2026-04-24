import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { Logger } from "@onenomad/cortex-core";

/**
 * Bridge between Cortex's MCP tools and the browser extension.
 *
 * An extension connects to `ws://<cortex>/ws/browser`, advertises the
 * tabs it has open, and executes tool calls dispatched over the WS.
 * Each tool call carries a correlation id so requests and responses
 * can round-trip through the single socket.
 *
 * One bridge instance per Cortex process. Multiple extension clients
 * can connect — Claude's tool calls fan out to whichever session is
 * designated "primary" (first connected unless the user flipped the
 * preference). Secondary sessions are kept alive for future multi-
 * profile scenarios but don't receive tool traffic today.
 */

export interface BrowserTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  /** If the user paused tools on this tab, it's hidden from Claude. */
  paused?: boolean;
}

export interface BrowserSession {
  id: string;
  ws: WebSocket;
  tabs: BrowserTab[];
  /** "all" | "active" | list of allowed host patterns (prefix match). */
  scope: { mode: "all" | "active" | "allowlist"; hosts: string[] };
  /** When this session first connected. */
  connectedAt: number;
}

export interface BrowserToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Default 30_000 ms. Navigate + wait_for get a longer override. */
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class BrowserBridge {
  private readonly wss: WebSocketServer;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly pending = new Map<string, PendingCall>();
  private primaryId: string | undefined;

  constructor(opts: { logger: Logger }) {
    this.logger = opts.logger.child({ component: "browser-bridge" });
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  /**
   * Hook into an existing HTTP server's upgrade event. Call from the
   * server that owns the underlying port so /ws/browser shares
   * whichever port the dashboard API is already bound to.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws/browser") return false;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
    return true;
  }

  /** Is there at least one active browser session? */
  hasSession(): boolean {
    return this.sessions.size > 0;
  }

  /** Primary session used for tool dispatch. First-connected wins. */
  primary(): BrowserSession | undefined {
    if (!this.primaryId) return undefined;
    return this.sessions.get(this.primaryId);
  }

  /** All connected sessions. For status reporting. */
  all(): BrowserSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Send a tool call to the primary session and wait for a result.
   * Throws a structured error when no session is connected, when the
   * extension reports an error, or when the call times out.
   */
  async call<T = unknown>(call: BrowserToolCall): Promise<T> {
    const session = this.primary();
    if (!session) {
      throw new BrowserNotConnectedError();
    }
    if (session.ws.readyState !== 1) {
      throw new BrowserNotConnectedError(
        "extension websocket is not open (readyState != OPEN)",
      );
    }
    const callId = randomUUID();
    const timeoutMs = call.timeoutMs ?? 30_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(
          new Error(
            `browser_bridge: '${call.tool}' timed out after ${timeoutMs}ms — is the tab responsive?`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(callId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      session.ws.send(
        JSON.stringify({
          type: "tool.call",
          callId,
          tool: call.tool,
          args: call.args,
          timeoutMs,
        }),
      );
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const id = randomUUID();
    const session: BrowserSession = {
      id,
      ws,
      tabs: [],
      scope: { mode: "all", hosts: [] },
      connectedAt: Date.now(),
    };
    this.sessions.set(id, session);
    if (!this.primaryId) this.primaryId = id;
    this.logger.info("browser_bridge.connected", {
      sessionId: id,
      remote: req.socket.remoteAddress,
      total: this.sessions.size,
    });

    ws.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        this.logger.warn("browser_bridge.bad_frame", {
          sample: data.toString().slice(0, 200),
        });
        return;
      }
      this.handleFrame(session, frame);
    });

    ws.on("close", () => {
      this.sessions.delete(id);
      if (this.primaryId === id) {
        // Promote another session if any exist.
        this.primaryId = this.sessions.keys().next().value;
      }
      this.logger.info("browser_bridge.disconnected", {
        sessionId: id,
        remaining: this.sessions.size,
      });
    });

    ws.on("error", (err) => {
      this.logger.warn("browser_bridge.socket_error", {
        sessionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Greet: tell the extension its session id + current bridge state.
    ws.send(
      JSON.stringify({
        type: "bridge.hello",
        sessionId: id,
        primary: this.primaryId === id,
      }),
    );
  }

  private handleFrame(session: BrowserSession, frame: unknown): void {
    if (!frame || typeof frame !== "object") return;
    const body = frame as { type?: string } & Record<string, unknown>;

    switch (body.type) {
      case "session.tabs": {
        // Extension pushes its current tab list. Keep in sync.
        const tabs = Array.isArray(body.tabs) ? (body.tabs as BrowserTab[]) : [];
        session.tabs = tabs;
        return;
      }
      case "session.scope": {
        const mode = body.mode as BrowserSession["scope"]["mode"];
        const hosts = Array.isArray(body.hosts) ? (body.hosts as string[]) : [];
        if (mode === "all" || mode === "active" || mode === "allowlist") {
          session.scope = { mode, hosts };
        }
        return;
      }
      case "tool.result": {
        const callId = typeof body.callId === "string" ? body.callId : "";
        const pending = this.pending.get(callId);
        if (!pending) return;
        this.pending.delete(callId);
        clearTimeout(pending.timer);
        pending.resolve(body.result);
        return;
      }
      case "tool.error": {
        const callId = typeof body.callId === "string" ? body.callId : "";
        const pending = this.pending.get(callId);
        if (!pending) return;
        this.pending.delete(callId);
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            typeof body.error === "string"
              ? body.error
              : "browser bridge: unknown tool error",
          ),
        );
        return;
      }
      default:
        this.logger.debug("browser_bridge.unknown_frame_type", {
          type: body.type,
        });
    }
  }
}

/**
 * Thrown by `BrowserBridge.call` when no extension is connected or
 * the socket is closed. Lets MCP tool handlers surface a clear
 * "open Cortex in your browser first" message instead of a cryptic
 * timeout or network error.
 */
export class BrowserNotConnectedError extends Error {
  constructor(
    message = "No browser extension connected. Open the Cortex extension on the tab you want Claude to drive.",
  ) {
    super(message);
    this.name = "BrowserNotConnectedError";
  }
}

let sharedBridge: BrowserBridge | undefined;

export function getSharedBrowserBridge(logger: Logger): BrowserBridge {
  if (!sharedBridge) sharedBridge = new BrowserBridge({ logger });
  return sharedBridge;
}
