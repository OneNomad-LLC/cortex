import { z } from "zod";
import {
  BrowserNotConnectedError,
  getSharedBrowserBridge,
} from "../../browser-bridge.js";
import type { McpTool } from "../tool.js";

/**
 * Browser-control MCP tools routed over the Cortex browser bridge.
 * Claude calls these the same way it calls any other Cortex tool; the
 * bridge forwards the call to the connected extension, which runs it
 * in the user's actual browser against whatever tabs they have open.
 *
 * Tool-call contract:
 *   - All tools fail cleanly when no extension is connected
 *     (BrowserNotConnectedError maps to a readable message).
 *   - Default timeout 30s; navigate + wait_for get 60s.
 *   - `tabId` is optional on most tools; when omitted the extension
 *     targets the currently active tab.
 *   - Results are JSON-serializable by contract — images come back as
 *     base64 data URLs for vision-capable models to interpret.
 */

// ---------------- browser_status -------------------------------------

const statusSchema = z.object({});
interface StatusOutput {
  connected: boolean;
  sessionCount: number;
  primary?: {
    id: string;
    connectedAt: string;
    tabCount: number;
    scopeMode: string;
  };
}

export const browserStatus: McpTool<typeof statusSchema, StatusOutput> = {
  name: "browser_status",
  description:
    "Check whether the Cortex browser extension is connected and " +
    "what scope the user has allowed. Call this first if you're " +
    "unsure the browser tools are available — a clean error from " +
    "`browser_list_tabs` also indicates no session, so this is " +
    "optional.",
  inputSchema: statusSchema,
  async handler(_input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    const primary = bridge.primary();
    const out: StatusOutput = {
      connected: bridge.hasSession(),
      sessionCount: bridge.all().length,
    };
    if (primary) {
      out.primary = {
        id: primary.id,
        connectedAt: new Date(primary.connectedAt).toISOString(),
        tabCount: primary.tabs.length,
        scopeMode: primary.scope.mode,
      };
    }
    return out;
  },
};

// ---------------- browser_list_tabs -----------------------------------

const listTabsSchema = z.object({
  /** Case-insensitive substring filter against URL + title. */
  match: z.string().optional(),
  /** Only return tabs whose URL host contains this substring. */
  host: z.string().optional(),
});
interface ListTabsOutput {
  tabs: Array<{
    id: number;
    url: string;
    title: string;
    active: boolean;
  }>;
}

export const browserListTabs: McpTool<typeof listTabsSchema, ListTabsOutput> = {
  name: "browser_list_tabs",
  description:
    "List every open browser tab the user has allowed Cortex to see. " +
    "Use BEFORE other browser tools when you need to pick a target " +
    "(e.g., for 'check my email' → filter by host: 'outlook'). " +
    "Respects the user's scope setting (all/active/allowlist) and " +
    "skips tabs they explicitly paused.",
  inputSchema: listTabsSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    const session = bridge.primary();
    if (!session) throw new BrowserNotConnectedError();

    let tabs = session.tabs.filter((t) => !t.paused);
    if (input.match) {
      const q = input.match.toLowerCase();
      tabs = tabs.filter(
        (t) =>
          t.url.toLowerCase().includes(q) || t.title.toLowerCase().includes(q),
      );
    }
    if (input.host) {
      const h = input.host.toLowerCase();
      tabs = tabs.filter((t) => {
        try {
          return new URL(t.url).hostname.toLowerCase().includes(h);
        } catch {
          return false;
        }
      });
    }
    return {
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
    };
  },
};

// ---------------- browser_read_page -----------------------------------

const readPageSchema = z.object({
  /** Defaults to the currently active tab when omitted. */
  tabId: z.number().int().optional(),
  /**
   * When true, return the full rendered HTML. Default false — text is
   * usually enough for reasoning and avoids blowing the context.
   */
  includeHtml: z.boolean().default(false),
});
interface ReadPageOutput {
  tabId: number;
  url: string;
  title: string;
  text: string;
  html?: string;
}

export const browserReadPage: McpTool<typeof readPageSchema, ReadPageOutput> = {
  name: "browser_read_page",
  description:
    "Read the current rendered content of a browser tab. Returns " +
    "page title, URL, and visible text. Pass `includeHtml: true` " +
    "only if you genuinely need the markup — text is usually enough " +
    "and avoids flooding the context. Defaults to active tab when " +
    "`tabId` is omitted.",
  inputSchema: readPageSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<ReadPageOutput>({
      tool: "read_page",
      args: input as Record<string, unknown>,
    });
  },
};

// ---------------- browser_read_selection ------------------------------

const readSelectionSchema = z.object({
  tabId: z.number().int().optional(),
});
interface ReadSelectionOutput {
  tabId: number;
  text: string;
  url: string;
  hasSelection: boolean;
}

export const browserReadSelection: McpTool<
  typeof readSelectionSchema,
  ReadSelectionOutput
> = {
  name: "browser_read_selection",
  description:
    "Get the text the user currently has selected in the tab. " +
    "`hasSelection: false` means nothing's selected — don't treat " +
    "the empty string as content in that case.",
  inputSchema: readSelectionSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<ReadSelectionOutput>({
      tool: "read_selection",
      args: input as Record<string, unknown>,
    });
  },
};

// ---------------- browser_screenshot ----------------------------------

const screenshotSchema = z.object({
  tabId: z.number().int().optional(),
  /** Image quality 0-100. Default 80 — plenty for vision models. */
  quality: z.number().int().min(10).max(100).default(80),
});
interface ScreenshotOutput {
  tabId: number;
  url: string;
  /** data:image/jpeg;base64,... — pass-through for vision models. */
  image: string;
  format: "jpeg" | "png";
  widthPx: number;
  heightPx: number;
}

export const browserScreenshot: McpTool<
  typeof screenshotSchema,
  ScreenshotOutput
> = {
  name: "browser_screenshot",
  description:
    "Take a screenshot of a browser tab (visible viewport only) and " +
    "return it as a base64 data URL. Use when you need to reason " +
    "about visual layout — reading DOM text is usually faster and " +
    "cheaper.",
  inputSchema: screenshotSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<ScreenshotOutput>({
      tool: "screenshot",
      args: input as Record<string, unknown>,
      timeoutMs: 15_000,
    });
  },
};

// ---------------- browser_click ---------------------------------------

const clickSchema = z.object({
  tabId: z.number().int().optional(),
  selector: z.string().min(1),
  /**
   * When set, scrolls the element into view before clicking.
   * Default true — most intentional clicks want this.
   */
  scrollIntoView: z.boolean().default(true),
});
interface ClickOutput {
  tabId: number;
  clicked: boolean;
  matchedCount: number;
}

export const browserClick: McpTool<typeof clickSchema, ClickOutput> = {
  name: "browser_click",
  description:
    "Click a DOM element matching a CSS selector. When multiple " +
    "match, clicks the first. Returns `matchedCount` so you can " +
    "detect ambiguous or missing selectors. Prefer aria-label or " +
    "data-* selectors over class-based ones for stability.",
  inputSchema: clickSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<ClickOutput>({
      tool: "click",
      args: input as Record<string, unknown>,
    });
  },
};

// ---------------- browser_scroll --------------------------------------

const scrollSchema = z.object({
  tabId: z.number().int().optional(),
  /** "down" | "up" | "top" | "bottom". Default "down". */
  direction: z.enum(["down", "up", "top", "bottom"]).default("down"),
  /** Pixels (for up/down). Ignored for top/bottom. Default 800. */
  amount: z.number().int().positive().default(800),
});
interface ScrollOutput {
  tabId: number;
  scrollY: number;
  maxScrollY: number;
}

export const browserScroll: McpTool<typeof scrollSchema, ScrollOutput> = {
  name: "browser_scroll",
  description:
    "Scroll a tab's viewport. Useful for lazy-loaded content " +
    "(Jira boards, long email threads). Returns the post-scroll " +
    "position so you can tell if you've hit the bottom.",
  inputSchema: scrollSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<ScrollOutput>({
      tool: "scroll",
      args: input as Record<string, unknown>,
    });
  },
};

// ---------------- browser_navigate ------------------------------------

const navigateSchema = z.object({
  tabId: z.number().int().optional(),
  url: z.string().url(),
  /**
   * When true, wait for the page's load event before returning.
   * Default true. Disable only if you need to inspect the initial
   * DOM before heavy JS runs.
   */
  waitForLoad: z.boolean().default(true),
});
interface NavigateOutput {
  tabId: number;
  url: string;
  title: string;
}

export const browserNavigate: McpTool<typeof navigateSchema, NavigateOutput> = {
  name: "browser_navigate",
  description:
    "Navigate a tab to a new URL. Default waits for the load event " +
    "before returning, so the next `read_page` sees the finished DOM.",
  inputSchema: navigateSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<NavigateOutput>({
      tool: "navigate",
      args: input as Record<string, unknown>,
      timeoutMs: 60_000,
    });
  },
};

// ---------------- browser_wait_for ------------------------------------

const waitForSchema = z.object({
  tabId: z.number().int().optional(),
  selector: z.string().min(1),
  /** Max ms to wait. Default 10s. */
  timeoutMs: z.number().int().positive().max(60_000).default(10_000),
});
interface WaitForOutput {
  tabId: number;
  found: boolean;
  elapsedMs: number;
}

export const browserWaitFor: McpTool<typeof waitForSchema, WaitForOutput> = {
  name: "browser_wait_for",
  description:
    "Wait for a CSS selector to appear in the DOM, up to " +
    "`timeoutMs`. Use after `navigate` or `click` on single-page " +
    "apps that render async (Jira, Slack). Returns whether the " +
    "element appeared and how long it took.",
  inputSchema: waitForSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<WaitForOutput>({
      tool: "wait_for",
      args: input as Record<string, unknown>,
      timeoutMs: input.timeoutMs + 5_000,
    });
  },
};

// ---------------- browser_fill ----------------------------------------

const fillSchema = z.object({
  tabId: z.number().int().optional(),
  selector: z.string().min(1),
  value: z.string(),
  /**
   * When true, emits an `input` + `change` event after setting the
   * value so React/Vue listeners update. Default true.
   */
  fireEvents: z.boolean().default(true),
});
interface FillOutput {
  tabId: number;
  filled: boolean;
}

export const browserFill: McpTool<typeof fillSchema, FillOutput> = {
  name: "browser_fill",
  description:
    "Type a value into an input element. Handles React-controlled " +
    "inputs by firing input + change events by default. Won't work " +
    "for contenteditable editors — use `browser_click` + the " +
    "browser_type_text tool (not yet exposed) for those.",
  inputSchema: fillSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<FillOutput>({
      tool: "fill",
      args: input as Record<string, unknown>,
    });
  },
};

// ---------------- browser_switch_tab ----------------------------------

const switchTabSchema = z.object({
  tabId: z.number().int(),
});
interface SwitchTabOutput {
  tabId: number;
  url: string;
  title: string;
}

export const browserSwitchTab: McpTool<
  typeof switchTabSchema,
  SwitchTabOutput
> = {
  name: "browser_switch_tab",
  description:
    "Focus a specific tab (raise it in the browser). Tools that " +
    "omit `tabId` will then operate on this newly-active tab.",
  inputSchema: switchTabSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<SwitchTabOutput>({
      tool: "switch_tab",
      args: input as Record<string, unknown>,
    });
  },
};

// ---------------- browser_query_selector_all -------------------------

const querySelectorAllSchema = z.object({
  tabId: z.number().int().optional(),
  selector: z.string().min(1),
  /** Cap on number of matches returned. Default 50. */
  limit: z.number().int().positive().max(500).default(50),
  /**
   * When true, include a truncated innerHTML snippet for each match
   * (useful for reading rich text like Slack messages). Default false
   * — text-only keeps results compact.
   */
  includeHtml: z.boolean().default(false),
  /**
   * Per-attribute allowlist — only these attributes are returned on
   * each match. Use to reduce payload size. When empty (default),
   * every attribute is returned.
   */
  attributes: z.array(z.string()).default([]),
});
interface QueryMatch {
  text: string;
  attributes: Record<string, string>;
  html?: string;
}
interface QuerySelectorAllOutput {
  tabId: number;
  url: string;
  selector: string;
  totalMatched: number;
  returned: number;
  matches: QueryMatch[];
}

export const browserQuerySelectorAll: McpTool<
  typeof querySelectorAllSchema,
  QuerySelectorAllOutput
> = {
  name: "browser_query_selector_all",
  description:
    "Run `document.querySelectorAll(selector)` in a tab and return " +
    "just the matching elements — text content, attributes, " +
    "optionally truncated HTML. Use this instead of `browser_read_page` " +
    "when you need specific structured data (channel list items, table " +
    "rows, ticket cards, message blocks). Way cheaper in tokens than " +
    "pulling the whole DOM and regex-parsing it. `totalMatched` " +
    "reports the pre-limit count so you can tell when there's more.",
  inputSchema: querySelectorAllSchema,
  async handler(input, ctx) {
    const bridge = getSharedBrowserBridge(ctx.logger);
    return bridge.call<QuerySelectorAllOutput>({
      tool: "query_selector_all",
      args: input as Record<string, unknown>,
    });
  },
};

export const ALL_BROWSER_TOOLS = [
  browserStatus,
  browserListTabs,
  browserReadPage,
  browserReadSelection,
  browserQuerySelectorAll,
  browserScreenshot,
  browserClick,
  browserScroll,
  browserNavigate,
  browserWaitFor,
  browserFill,
  browserSwitchTab,
];
