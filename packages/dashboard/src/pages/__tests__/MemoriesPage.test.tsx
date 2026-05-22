import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MemoriesPage } from "@/pages/MemoriesPage";
import { renderApp } from "@/test/render";

/**
 * MemoriesPage tests pin the user-visible contracts:
 *   1. Initial list render — type badges (incl. Dossier) appear.
 *   2. Type filter toggles append ?type= to the request URL.
 *   3. Detail dialog opens and renders the full body as markdown.
 *
 * fetch is stubbed via a matcher queue (same pattern as the
 * GitHubReposPage tests). renderApp boots a fresh QueryClient per
 * test so cached responses don't leak between cases.
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
  enqueue(
    (url) => url.includes("/auth/whoami"),
    {
      workspace: "default",
      scopes: ["admin"],
      tokenLabel: "default",
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

const DOSSIER_MEMORY = {
  id: "mem-1",
  title: "Cortex architecture brief",
  type: "brief",
  source: "github",
  sourceId: "github:OneNomad-LLC/cortex:README.md",
  sourceUrl: "https://github.com/OneNomad-LLC/cortex",
  project: "cortex",
  date: "2026-04-12T00:00:00.000Z",
  createdAt: "2026-04-12T00:00:00.000Z",
  snippet: "Universal memory + knowledge engine for AI agents.",
  tags: ["dossier", "project:cortex", "source:github"],
  isDossier: true,
};

const PLAIN_MEMORY = {
  id: "mem-2",
  title: "Quarterly review notes",
  type: "doc",
  source: "manual",
  sourceId: "manual:q1-review",
  sourceUrl: null,
  project: "ops",
  date: "2026-03-30T00:00:00.000Z",
  createdAt: "2026-03-30T00:00:00.000Z",
  snippet: "Bullet list of Q1 outcomes…",
  tags: ["project:ops"],
  isDossier: false,
};

describe("<MemoriesPage />", () => {
  it("renders the list with a Dossier badge on tagged briefs", async () => {
    enqueue(
      (url) => url.includes("/api/dashboard/memories?"),
      {
        memories: [DOSSIER_MEMORY, PLAIN_MEMORY],
        total: 2,
        page: 1,
        perPage: 50,
        hasMore: false,
        workspace: "default",
      },
    );

    renderApp(<MemoriesPage />, { route: "/memories" });

    expect(
      await screen.findByText("Cortex architecture brief"),
    ).toBeTruthy();
    expect(screen.getByText("Quarterly review notes")).toBeTruthy();
    // Dossier badge present on the brief row. The page-level
    // description also contains the word "Dossier", so we scope
    // strictly: find a badge-classed element by exact text.
    const dossierBadges = screen
      .getAllByText("Dossier")
      .filter((el) => el.tagName.toLowerCase() === "div");
    expect(dossierBadges.length).toBeGreaterThan(0);
    // Plain row falls back to the type name.
    expect(screen.getByText("doc")).toBeTruthy();
  });

  it("type filter checkbox appends ?type=brief to the next request", async () => {
    // First (no-filter) page.
    enqueue(
      (url) => url.includes("/api/dashboard/memories?") && !url.includes("type=brief"),
      {
        memories: [DOSSIER_MEMORY, PLAIN_MEMORY],
        total: 2,
        page: 1,
        perPage: 50,
        hasMore: false,
        workspace: "default",
      },
    );
    // After filter toggle.
    enqueue(
      (url) =>
        url.includes("/api/dashboard/memories?") && url.includes("type=brief"),
      {
        memories: [DOSSIER_MEMORY],
        total: 1,
        page: 1,
        perPage: 50,
        hasMore: false,
        workspace: "default",
      },
    );

    renderApp(<MemoriesPage />, { route: "/memories" });
    const user = userEvent.setup();
    await screen.findByText("Cortex architecture brief");

    // Toggle the "Brief" checkbox in the type filter row.
    const briefCheckbox = screen.getByLabelText("Filter type Brief");
    await user.click(briefCheckbox);

    await waitFor(() => {
      const filteredCall = calls.find(
        (c) =>
          c.url.includes("/api/dashboard/memories?") &&
          c.url.includes("type=brief"),
      );
      expect(filteredCall).toBeTruthy();
    });
  });

  it("opens the detail dialog and renders the full body", async () => {
    enqueue(
      (url) => url.includes("/api/dashboard/memories?"),
      {
        memories: [DOSSIER_MEMORY],
        total: 1,
        page: 1,
        perPage: 50,
        hasMore: false,
        workspace: "default",
      },
    );
    enqueue(
      (url) => url.includes("/api/dashboard/memories/mem-1"),
      {
        memory: {
          ...DOSSIER_MEMORY,
          content:
            "# Cortex\n\nCortex ingests work content and produces structured **briefs**.\n",
          metadata: { type: "brief", source: "github" },
        },
      },
    );

    renderApp(<MemoriesPage />, { route: "/memories" });
    const user = userEvent.setup();

    const titleButton = await screen.findByRole("button", {
      name: /Cortex architecture brief/i,
    });
    await user.click(titleButton);

    // Dialog renders the markdown-rendered heading.
    const dialog = await screen.findByRole("dialog");
    // The markdown renderer produces a real <strong> for "**briefs**".
    // The page description outside the dialog also contains "briefs",
    // so scope the check to nodes inside the dialog.
    const strongs = dialog.querySelectorAll("strong");
    expect(Array.from(strongs).some((n) => n.textContent === "briefs")).toBe(
      true,
    );
    // The detail call fired against the slug-scoped endpoint.
    expect(
      calls.find((c) => c.url.includes("/api/dashboard/memories/mem-1")),
    ).toBeTruthy();
  });
});
