/**
 * Executors for the 11 browser-bridge tools. Each tool takes the
 * JSON `args` the server forwards (shape matches `mcp/tools/browser.ts`)
 * and returns the JSON payload the server expects to relay back to
 * Claude.
 *
 * Cross-tab scripting uses `chrome.scripting.executeScript` with
 * `world: "MAIN"` where we need to touch page-controlled globals —
 * right now only `fill` benefits from it. Everything else runs in
 * ISOLATED, which is safer.
 *
 * The `tabId` argument is optional on most tools: when omitted we
 * query the active tab of the last-focused window. Chrome returns
 * zero results if no window has focus (e.g., DevTools detached), so
 * we fall back to `active: true` without the window constraint.
 */

interface ToolContext {
  /** Flash the toolbar badge so the user sees activity. */
  flashBadge(label: string): void;
}

/* Chrome's script payloads are stringified and evaluated inside the
 * tab, so they can't close over outer variables. We pass everything
 * via `args` and return JSON-friendly objects. */

export async function runTool(
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (tool) {
    case "read_page":
      ctx.flashBadge("R");
      return readPage(args);
    case "read_selection":
      ctx.flashBadge("S");
      return readSelection(args);
    case "query_selector_all":
      ctx.flashBadge("Q");
      return queryAll(args);
    case "screenshot":
      ctx.flashBadge("P");
      return screenshot(args);
    case "click":
      ctx.flashBadge("C");
      return click(args);
    case "scroll":
      ctx.flashBadge("V");
      return scroll(args);
    case "navigate":
      ctx.flashBadge("N");
      return navigate(args);
    case "wait_for":
      ctx.flashBadge("W");
      return waitFor(args);
    case "fill":
      ctx.flashBadge("F");
      return fill(args);
    case "switch_tab":
      ctx.flashBadge("T");
      return switchTab(args);
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

/* ---------- helpers ------------------------------------------------- */

/**
 * Resolve the target tab. If `tabId` is provided we trust it (and
 * surface a readable error if the tab is gone). Otherwise we pick the
 * active tab in the last-focused window; if the user's desktop has no
 * focused Chrome window (minimized, DevTools undocked), we fall back
 * to any active tab.
 */
async function resolveTab(rawTabId: unknown): Promise<chrome.tabs.Tab> {
  if (typeof rawTabId === "number" && Number.isFinite(rawTabId)) {
    const tab = await chrome.tabs.get(rawTabId).catch(() => undefined);
    if (!tab) throw new Error(`tab ${rawTabId} no longer exists`);
    return tab;
  }
  const [byFocused] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (byFocused) return byFocused;
  const [anyActive] = await chrome.tabs.query({ active: true });
  if (anyActive) return anyActive;
  throw new Error("no active tab — open a tab to give Claude something to read");
}

async function execInTab<TArgs extends unknown[], TResult>(
  tabId: number,
  func: (...args: TArgs) => TResult,
  args: TArgs,
): Promise<TResult> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: func as (...a: unknown[]) => unknown,
    args: args as unknown[],
  });
  // A frame that returned `undefined` explicitly comes back as
  // `{result: undefined}`; anything worse (crashed frame, tab gone)
  // is surfaced via the reject path of executeScript.
  return res?.result as TResult;
}

/* ---------- tool implementations ------------------------------------ */

async function readPage(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const includeHtml = args.includeHtml === true;
  const payload = await execInTab(
    tab.id,
    (opts: { includeHtml: boolean }) => {
      const text = (document.body?.innerText ?? "").slice(0, 60_000);
      const title = document.title;
      const url = location.href;
      const res: { text: string; title: string; url: string; html?: string } =
        { text, title, url };
      if (opts.includeHtml) {
        res.html = document.documentElement.outerHTML.slice(0, 200_000);
      }
      return res;
    },
    [{ includeHtml }],
  );
  return { tabId: tab.id, ...payload };
}

async function readSelection(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const payload = await execInTab(
    tab.id,
    () => {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : "";
      return {
        text,
        url: location.href,
        hasSelection: text.length > 0,
      };
    },
    [],
  );
  return { tabId: tab.id, ...payload };
}

async function queryAll(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const selector = typeof args.selector === "string" ? args.selector : "";
  if (!selector) throw new Error("query_selector_all: selector required");
  const limit =
    typeof args.limit === "number" && args.limit > 0 ? args.limit : 50;
  const includeHtml = args.includeHtml === true;
  const attrs = Array.isArray(args.attributes)
    ? (args.attributes.filter((a) => typeof a === "string") as string[])
    : [];

  const payload = await execInTab(
    tab.id,
    ({ selector, limit, includeHtml, attrs }) => {
      let nodes: Element[];
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch (err) {
        throw new Error(`invalid selector: ${(err as Error).message}`);
      }
      const totalMatched = nodes.length;
      const slice = nodes.slice(0, limit);
      const matches = slice.map((el) => {
        const attributes: Record<string, string> = {};
        if (attrs.length > 0) {
          for (const name of attrs) {
            const v = el.getAttribute(name);
            if (v !== null) attributes[name] = v;
          }
        } else {
          for (const attr of el.attributes) {
            attributes[attr.name] = attr.value;
          }
        }
        // Trim big blobs — Claude rarely needs megabyte-scale per-match.
        const text = (el.textContent ?? "").trim().slice(0, 2_000);
        const htmlField = includeHtml
          ? { html: (el as HTMLElement).outerHTML.slice(0, 5_000) }
          : {};
        return { text, attributes, ...htmlField };
      });
      return {
        url: location.href,
        selector,
        totalMatched,
        returned: matches.length,
        matches,
      };
    },
    [{ selector, limit, includeHtml, attrs }],
  );
  return { tabId: tab.id, ...payload };
}

async function screenshot(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");

  // captureVisibleTab only captures the *focused* window's visible
  // tab. If the target tab isn't active in its window, we must raise
  // it first; otherwise we'd silently capture whatever the user is
  // actually looking at.
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  const quality =
    typeof args.quality === "number" && args.quality > 0
      ? Math.min(100, Math.max(10, Math.floor(args.quality)))
      : 80;

  const windowId = tab.windowId;
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality,
  });
  // Decode dimensions from the data URL by loading into an ImageBitmap
  // in the service worker — no DOM needed. Base64 comes after ",".
  const { width, height } = await measureDataUrl(dataUrl);
  return {
    tabId: tab.id,
    url: tab.url ?? "",
    image: dataUrl,
    format: "jpeg" as const,
    widthPx: width,
    heightPx: height,
  };
}

async function measureDataUrl(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return dims;
  } catch {
    // Width/height are optional metadata; don't fail the whole tool.
    return { width: 0, height: 0 };
  }
}

async function click(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const selector = String(args.selector ?? "");
  const scrollIntoView = args.scrollIntoView !== false;
  if (!selector) throw new Error("selector is required");

  const payload = await execInTab(
    tab.id,
    (opts: { selector: string; scrollIntoView: boolean }) => {
      const matches = document.querySelectorAll(opts.selector);
      const el = matches[0] as HTMLElement | undefined;
      if (!el) return { clicked: false, matchedCount: 0 };
      if (opts.scrollIntoView) {
        try {
          el.scrollIntoView({ block: "center", inline: "nearest" });
        } catch {
          /* older browsers / SVG edge cases — keep going */
        }
      }
      el.click();
      return { clicked: true, matchedCount: matches.length };
    },
    [{ selector, scrollIntoView }],
  );
  return { tabId: tab.id, ...payload };
}

async function scroll(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const direction = (args.direction as string) ?? "down";
  const amount =
    typeof args.amount === "number" && args.amount > 0
      ? Math.floor(args.amount)
      : 800;
  const payload = await execInTab(
    tab.id,
    (opts: { direction: string; amount: number }) => {
      const doc = document.scrollingElement ?? document.documentElement;
      const maxScrollY = Math.max(0, doc.scrollHeight - window.innerHeight);
      switch (opts.direction) {
        case "up":
          window.scrollBy({ top: -opts.amount, behavior: "auto" });
          break;
        case "down":
          window.scrollBy({ top: opts.amount, behavior: "auto" });
          break;
        case "top":
          window.scrollTo({ top: 0, behavior: "auto" });
          break;
        case "bottom":
          window.scrollTo({ top: maxScrollY, behavior: "auto" });
          break;
        default:
          window.scrollBy({ top: opts.amount, behavior: "auto" });
      }
      return { scrollY: window.scrollY, maxScrollY };
    },
    [{ direction, amount }],
  );
  return { tabId: tab.id, ...payload };
}

async function navigate(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const url = String(args.url ?? "");
  if (!url) throw new Error("url is required");
  const waitForLoad = args.waitForLoad !== false;

  const updated = await chrome.tabs.update(tab.id, { url });
  if (!updated || !updated.id) throw new Error("failed to update tab url");
  if (waitForLoad) {
    await awaitLoadComplete(updated.id);
  }
  const fresh = await chrome.tabs.get(updated.id);
  return {
    tabId: fresh.id ?? updated.id,
    url: fresh.url ?? url,
    title: fresh.title ?? "",
  };
}

function awaitLoadComplete(tabId: number, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
    ): void => {
      if (id !== tabId) return;
      if (info.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const cleanup = (): void => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer) clearTimeout(timer);
    };
    timer = setTimeout(() => {
      cleanup();
      // Don't reject — the tool's wrapper timeout is the source of
      // truth. Resolving lets the caller still query the tab state.
      resolve();
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // Catch the already-loaded race: the status may have flipped
    // before we attached.
    chrome.tabs.get(tabId).then(
      (t) => {
        if (t.status === "complete") {
          cleanup();
          resolve();
        }
      },
      (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function waitFor(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const selector = String(args.selector ?? "");
  if (!selector) throw new Error("selector is required");
  const timeoutMs =
    typeof args.timeoutMs === "number" && args.timeoutMs > 0
      ? Math.min(60_000, Math.floor(args.timeoutMs))
      : 10_000;

  const payload = await execInTab(
    tab.id,
    async (opts: { selector: string; timeoutMs: number }) => {
      const started = Date.now();
      while (Date.now() - started < opts.timeoutMs) {
        if (document.querySelector(opts.selector)) {
          return { found: true, elapsedMs: Date.now() - started };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return { found: false, elapsedMs: Date.now() - started };
    },
    [{ selector, timeoutMs }],
  );
  return { tabId: tab.id, ...payload };
}

async function fill(args: Record<string, unknown>): Promise<unknown> {
  const tab = await resolveTab(args.tabId);
  if (!tab.id) throw new Error("target tab has no id");
  const selector = String(args.selector ?? "");
  const value = String(args.value ?? "");
  const fireEvents = args.fireEvents !== false;
  if (!selector) throw new Error("selector is required");

  const payload = await execInTab(
    tab.id,
    (opts: { selector: string; value: string; fireEvents: boolean }) => {
      const el = document.querySelector(opts.selector) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (!el) return { filled: false };
      // React/Vue use a getter/setter on the prototype — assigning
      // `.value` directly bypasses their tracking. Use the native
      // setter so controlled inputs actually see the change.
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc?.set) {
        desc.set.call(el, opts.value);
      } else {
        el.value = opts.value;
      }
      if (opts.fireEvents) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { filled: true };
    },
    [{ selector, value, fireEvents }],
  );
  return { tabId: tab.id, ...payload };
}

async function switchTab(args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.tabId !== "number") throw new Error("tabId is required");
  const tab = await chrome.tabs.get(args.tabId);
  if (!tab.id) throw new Error(`tab ${args.tabId} no longer exists`);
  const updated = await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* windows API may not be available; the tab still activated */
    }
  }
  return {
    tabId: updated?.id ?? tab.id,
    url: updated?.url ?? tab.url ?? "",
    title: updated?.title ?? tab.title ?? "",
  };
}
