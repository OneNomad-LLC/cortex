import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GitHubReposPage } from "@/pages/GitHubReposPage";
import { renderApp } from "@/test/render";

/**
 * GitHubReposPage tests focus on the three load-bearing UI paths:
 *
 *   1. The 412 "github_not_connected" empty state.
 *   2. The table render + multi-select sync POST.
 *   3. The per-row sync action.
 *   4. The disconnect flow including the "purge memories" checkbox.
 *
 * Tests stub `fetch` directly via a small matcher queue, matching the
 * style of the existing `api.test.ts`. We don't render `<App />` —
 * just the page wrapped in our shared providers via `renderApp`.
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

function enqueue(
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
  // AuthProvider's whoami probe at mount.
  enqueue(
    (url) => url.includes("/auth/whoami"),
    {
      workspace: "default",
      scopes: ["read", "ingest"],
      tokenLabel: "github:matt",
    },
  );
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const initSafe = init ?? {};
      calls.push({ url, init: initSafe });
      const idx = queue.findIndex((q) => q.matcher(url, initSafe));
      if (idx === -1) {
        return jsonResponse({ error: "unmatched", url }, 404);
      }
      const [hit] = queue.splice(idx, 1);
      return jsonResponse(hit!.body, hit!.status);
    },
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("<GitHubReposPage />", () => {
  it("renders the not-connected empty state when /repos returns 412", async () => {
    enqueue(
      (url) => url.includes("/api/dashboard/github/repos"),
      { error: "github_not_connected" },
      412,
    );
    renderApp(<GitHubReposPage />, { route: "/integrations/github" });

    expect(
      await screen.findByText(/GitHub isn't connected to this session/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /go to login/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /re-authenticate/i }),
    ).toBeTruthy();
  });

  it("renders the table and the sync-selected button posts the right body", async () => {
    enqueue(
      (url) => url.includes("/api/dashboard/github/repos") && !url.includes("/sync"),
      {
        repos: [
          {
            fullName: "OneNomad-LLC/cortex",
            name: "cortex",
            owner: "OneNomad-LLC",
            htmlUrl: "https://github.com/OneNomad-LLC/cortex",
            language: "TypeScript",
            pushedAt: new Date(Date.now() - 60_000).toISOString(),
            status: "ingested",
          },
          {
            fullName: "OneNomad-LLC/przm-voice",
            name: "przm-voice",
            owner: "OneNomad-LLC",
            htmlUrl: "https://github.com/OneNomad-LLC/przm-voice",
            language: "TypeScript",
            pushedAt: new Date(Date.now() - 60_000).toISOString(),
            status: null,
          },
        ],
        total: 2,
        hasMore: false,
      },
    );
    enqueue(
      (url, init) =>
        url.endsWith("/api/dashboard/github/repos/sync") &&
        init.method === "POST",
      { jobs: [{ repo: "OneNomad-LLC/cortex", jobId: "job-1" }] },
    );

    renderApp(<GitHubReposPage />, { route: "/integrations/github" });
    const user = userEvent.setup();

    // Wait for the table to populate.
    expect(await screen.findByText("cortex")).toBeTruthy();
    expect(screen.getByText("przm-voice")).toBeTruthy();
    expect(screen.getByText(/Ingested ✓/)).toBeTruthy();

    // Pick the first row's checkbox.
    const firstRowCheckbox = screen.getByLabelText(
      "Select OneNomad-LLC/cortex",
    );
    await user.click(firstRowCheckbox);

    // Header sync button now reads "Sync selected (1)".
    const syncButton = await screen.findByRole("button", {
      name: /sync selected \(1\)/i,
    });
    await user.click(syncButton);

    await waitFor(() => {
      const syncCall = calls.find((c) =>
        c.url.endsWith("/api/dashboard/github/repos/sync"),
      );
      expect(syncCall).toBeTruthy();
      const body = JSON.parse(String(syncCall!.init.body));
      expect(body).toEqual({ repos: ["OneNomad-LLC/cortex"] });
      const headers = new Headers(syncCall!.init.headers ?? {});
      expect(headers.get("X-Cortex-Dashboard")).toBe("1");
    });
  });

  it("per-row Sync now hits the slug-scoped endpoint", async () => {
    enqueue(
      (url) =>
        url.includes("/api/dashboard/github/repos") && !url.includes("/sync"),
      {
        repos: [
          {
            fullName: "OneNomad-LLC/cortex",
            name: "cortex",
            owner: "OneNomad-LLC",
            htmlUrl: "https://github.com/OneNomad-LLC/cortex",
            pushedAt: null,
            status: null,
          },
        ],
        total: 1,
        hasMore: false,
      },
    );
    enqueue(
      (url, init) =>
        url.endsWith("/api/dashboard/github/repos/OneNomad-LLC/cortex/sync") &&
        init.method === "POST",
      { jobId: "job-row-1" },
    );

    renderApp(<GitHubReposPage />, { route: "/integrations/github" });
    const user = userEvent.setup();
    await screen.findByText("cortex");

    await user.click(
      screen.getByRole("button", {
        name: /Actions for OneNomad-LLC\/cortex/i,
      }),
    );
    const syncNowItem = await screen.findByText(/Sync now/i);
    await user.click(syncNowItem);

    await waitFor(() => {
      expect(
        calls.find((c) =>
          c.url.endsWith(
            "/api/dashboard/github/repos/OneNomad-LLC/cortex/sync",
          ),
        ),
      ).toBeTruthy();
    });
  });

  it("Disconnect with the purge checkbox sends purge=true on the DELETE", async () => {
    enqueue(
      (url) =>
        url.includes("/api/dashboard/github/repos") && !url.includes("/sync"),
      {
        repos: [
          {
            fullName: "OneNomad-LLC/cortex",
            name: "cortex",
            owner: "OneNomad-LLC",
            htmlUrl: "https://github.com/OneNomad-LLC/cortex",
            pushedAt: null,
            status: "ingested",
          },
        ],
        total: 1,
        hasMore: false,
      },
    );
    enqueue(
      (url, init) =>
        url.includes(
          "/api/dashboard/github/repos/OneNomad-LLC/cortex?purge=true",
        ) && init.method === "DELETE",
      { removed: true, memoriesPurged: 7 },
    );

    renderApp(<GitHubReposPage />, { route: "/integrations/github" });
    const user = userEvent.setup();
    await screen.findByText("cortex");

    // Open the actions menu, click Disconnect.
    await user.click(
      screen.getByRole("button", {
        name: /Actions for OneNomad-LLC\/cortex/i,
      }),
    );
    await user.click(await screen.findByText(/Disconnect/i));

    // Confirm dialog now visible with the purge checkbox.
    const dialog = await screen.findByRole("alertdialog");
    const purgeCheckbox = within(dialog).getByRole("checkbox");
    await user.click(purgeCheckbox);

    await user.click(
      within(dialog).getByRole("button", { name: /^Disconnect$/i }),
    );

    await waitFor(() => {
      const deleteCall = calls.find(
        (c) => c.init.method === "DELETE" && c.url.includes("purge=true"),
      );
      expect(deleteCall).toBeTruthy();
    });
  });
});
