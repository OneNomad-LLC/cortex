import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LoginPage } from "@/pages/LoginPage";
import { renderApp } from "@/test/render";

/**
 * Continue-with-GitHub flow on the LoginPage.
 *
 *   1. Initial render shows the "Continue with GitHub" button above
 *      the token-paste form.
 *   2. Clicking it POSTs `/api/dashboard/auth/github/start`.
 *   3. The userCode + verification link are rendered, polling fires.
 *   4. When `/poll` returns `authorized`, the SPA calls `whoami` then
 *      navigates to `/` (base-relative).
 *
 * Fetch is mocked per-test with a small queue so the assertions can
 * verify both the request shape (correct path, X-Cortex-Dashboard
 * header, etc.) and the response handling.
 */

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface QueuedResponse {
  matcher: (url: string, init: RequestInit) => boolean;
  body: unknown;
  status?: number;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[];
let queue: QueuedResponse[];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queueResponse(
  matcher: QueuedResponse["matcher"],
  body: unknown,
  status?: number,
): void {
  const entry: QueuedResponse = { matcher, body };
  if (status !== undefined) entry.status = status;
  queue.push(entry);
}

beforeEach(() => {
  calls = [];
  queue = [];
  // Default 401 on /whoami so AuthProvider settles to "anon" without
  // navigating anywhere (the LoginPage doesn't sit under ProtectedRoute
  // in our test render, so this is just bookkeeping).
  queueResponse(
    (url) => url.includes("/auth/whoami"),
    { error: "unauthorized" },
    401,
  );
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const initSafe = init ?? {};
    calls.push({ url, init: initSafe });
    const idx = queue.findIndex((q) => q.matcher(url, initSafe));
    if (idx === -1) {
      // Unmatched call — return 404 so the test fails loudly rather
      // than silently caching a default 200.
      return jsonResponse({ error: "unmatched", url }, 404);
    }
    const [hit] = queue.splice(idx, 1);
    return jsonResponse(hit!.body, hit!.status);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("<LoginPage /> — Continue with GitHub", () => {
  it("renders both auth options on first paint", async () => {
    renderApp(<LoginPage />, { route: "/login" });
    expect(
      await screen.findByRole("button", { name: /continue with github/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/dashboard token/i)).toBeTruthy();
  });

  it("starts the device flow, renders the user code, polls, then navigates", async () => {
    const user = userEvent.setup();

    queueResponse(
      (url, init) =>
        url.endsWith("/api/dashboard/auth/github/start") &&
        init.method === "POST",
      {
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        pollKey: "abc123",
        intervalMs: 20, // tight so the test doesn't wait
        expiresInMs: 600_000,
      },
    );
    queueResponse(
      (url, init) =>
        url.endsWith("/api/dashboard/auth/github/poll") &&
        init.method === "POST",
      { status: "pending" },
    );
    queueResponse(
      (url, init) =>
        url.endsWith("/api/dashboard/auth/github/poll") &&
        init.method === "POST",
      {
        status: "authorized",
        workspace: "default",
        scopes: ["read", "ingest"],
        login: "matt",
      },
    );
    // After authorized, the AuthProvider's refresh() re-hits /whoami.
    queueResponse(
      (url) => url.endsWith("/api/dashboard/auth/whoami"),
      {
        workspace: "default",
        scopes: ["read", "ingest"],
        tokenLabel: "github:matt",
      },
    );

    const { history } = renderApp(<LoginPage />, { route: "/login" });

    await user.click(
      await screen.findByRole("button", { name: /continue with github/i }),
    );

    // userCode rendered.
    expect(await screen.findByText("WDJB-MJHT")).toBeTruthy();
    // Verification link points at github.com.
    const verifyLink = screen.getByRole("link", {
      name: /open github\.com\/login\/device/i,
    });
    expect(verifyLink.getAttribute("href")).toBe(
      "https://github.com/login/device",
    );

    // Wait for the navigate to "/". Wouter applies the base prefix at
    // navigation time, so memoryLocation records the full
    // "/_dashboard/" path.
    await waitFor(() => {
      const last = history.at(-1) ?? "";
      expect(last === "/" || last === "/_dashboard/").toBe(true);
    });

    // /start should have been called exactly once with the CSRF header.
    const startCall = calls.find((c) =>
      c.url.endsWith("/api/dashboard/auth/github/start"),
    );
    expect(startCall).toBeTruthy();
    const startHeaders = new Headers(startCall!.init.headers ?? {});
    expect(startHeaders.get("X-Cortex-Dashboard")).toBe("1");
  });

  it("renders an allow-list error when /poll returns 403 not_allowlisted", async () => {
    const user = userEvent.setup();
    queueResponse(
      (url) => url.endsWith("/api/dashboard/auth/github/start"),
      {
        userCode: "TEST-CODE",
        verificationUri: "https://github.com/login/device",
        pollKey: "k1",
        intervalMs: 10,
        expiresInMs: 600_000,
      },
    );
    queueResponse(
      (url) => url.endsWith("/api/dashboard/auth/github/poll"),
      {
        status: "not_allowlisted",
        login: "stranger",
        message: "Your GitHub user stranger is not on the allow-list.",
      },
      403,
    );

    renderApp(<LoginPage />, { route: "/login" });
    await user.click(
      await screen.findByRole("button", { name: /continue with github/i }),
    );

    expect(
      await screen.findByText(/not on the allow-list/i),
    ).toBeTruthy();
  });
});
