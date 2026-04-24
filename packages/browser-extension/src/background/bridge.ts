/**
 * WebSocket client that keeps the extension wired to Cortex.
 *
 * Lifecycle: the background service worker instantiates this once on
 * startup. If Chrome evicts the worker (MV3 idle) the class is
 * re-created on the next event and reconnects from scratch. State is
 * intentionally in-memory only — the protocol is idempotent (re-send
 * `session.tabs` + `session.scope` on every connect).
 *
 * Reconnect backoff: exponential, capped at 30s. Reset to 1s on a
 * successful open. Reconnects happen on unexpected close (code ≠ 1000)
 * and on WS-level errors.
 */

import type { ScopeMode } from "../lib/storage";
import { runTool } from "./tools";

export interface BridgeOptions {
  /** Called when we connect (for UI badge). */
  onConnected?: (sessionId: string, primary: boolean) => void;
  /** Called when the socket drops (for UI badge). */
  onDisconnected?: () => void;
  /** Flash a short character on the toolbar badge. */
  flashBadge?: (label: string) => void;
}

type Frame =
  | { type: "session.tabs"; tabs: AdvertisedTab[] }
  | { type: "session.scope"; mode: ScopeMode; hosts: string[] }
  | { type: "tool.result"; callId: string; result: unknown }
  | { type: "tool.error"; callId: string; error: string };

export interface AdvertisedTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class Bridge {
  private ws: WebSocket | undefined;
  private url = "";
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionId: string | undefined;
  private primary = false;
  private lastTabs: AdvertisedTab[] = [];
  private lastScope: { mode: ScopeMode; hosts: string[] } = {
    mode: "all",
    hosts: [],
  };
  private closedByUs = false;

  constructor(private readonly opts: BridgeOptions = {}) {}

  /** Open (or reopen against a new URL). Safe to call repeatedly. */
  connect(url: string): void {
    if (this.url === url && this.ws && this.ws.readyState <= 1) {
      // Already connected or in-flight to this URL — nothing to do.
      return;
    }
    this.closedByUs = false;
    this.url = url;
    this.teardown();
    this.open();
  }

  /** Close and stop reconnecting. */
  disconnect(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && this.ws.readyState <= 1) {
      try {
        this.ws.close(1000, "extension shutdown");
      } catch {
        /* ignore */
      }
    }
    this.ws = undefined;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Push latest tab list (server keeps only the last one anyway). */
  sendTabs(tabs: AdvertisedTab[]): void {
    this.lastTabs = tabs;
    this.safeSend({ type: "session.tabs", tabs });
  }

  sendScope(mode: ScopeMode, hosts: string[]): void {
    this.lastScope = { mode, hosts };
    this.safeSend({ type: "session.scope", mode, hosts });
  }

  /* ---------------- internals --------------------------------------- */

  private open(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      console.warn("[cortex-bridge] construct failed", err);
      return;
    }

    this.ws.addEventListener("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      // Re-announce everything the server needs to make decisions
      // about us. Tabs list may be empty until the tab-tracker fires
      // its first debounced push.
      this.safeSend({
        type: "session.scope",
        mode: this.lastScope.mode,
        hosts: this.lastScope.hosts,
      });
      this.safeSend({ type: "session.tabs", tabs: this.lastTabs });
    });

    this.ws.addEventListener("message", (ev) => {
      void this.handleMessage(ev.data);
    });

    this.ws.addEventListener("close", (ev) => {
      this.opts.onDisconnected?.();
      this.sessionId = undefined;
      this.primary = false;
      if (!this.closedByUs && ev.code !== 1000) {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener("error", () => {
      // Chrome also fires `close` after `error`; let that path handle
      // the reconnect to avoid doubling up.
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(data));
    } catch {
      console.warn("[cortex-bridge] bad frame", data);
      return;
    }

    switch (frame.type) {
      case "bridge.hello": {
        this.sessionId = String(frame.sessionId ?? "");
        this.primary = frame.primary === true;
        console.info(
          "[cortex-bridge] hello",
          this.sessionId,
          "primary=",
          this.primary,
        );
        this.opts.onConnected?.(this.sessionId, this.primary);
        return;
      }
      case "tool.call": {
        const callId = String(frame.callId ?? "");
        const tool = String(frame.tool ?? "");
        const args = (frame.args as Record<string, unknown>) ?? {};
        if (!callId || !tool) {
          this.sendError(callId, "tool.call missing callId or tool");
          return;
        }
        try {
          const result = await runTool(tool, args, {
            flashBadge: (label) => this.opts.flashBadge?.(label),
          });
          this.safeSend({ type: "tool.result", callId, result });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err ?? "tool failed");
          this.sendError(callId, message);
        }
        return;
      }
      default:
        // Unknown frame types are ignored — server may add more later.
        return;
    }
  }

  private sendError(callId: string, error: string): void {
    this.safeSend({ type: "tool.error", callId, error });
  }

  private safeSend(frame: Frame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      console.warn("[cortex-bridge] send failed", err);
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUs) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  private teardown(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.ws) {
      try {
        this.ws.close(1000, "reconfigure");
      } catch {
        /* ignore */
      }
      this.ws = undefined;
    }
  }
}
