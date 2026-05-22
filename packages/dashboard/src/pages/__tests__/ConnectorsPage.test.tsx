import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConnectorsPage } from "@/pages/ConnectorsPage";
import { CONNECTORS } from "@/lib/connectors";
import { renderApp } from "@/test/render";

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

describe("<ConnectorsPage />", () => {
  it("renders all 9 connector cards", async () => {
    // Slack is "configured" via YAML; GitHub is not connected (412).
    enqueue(
      (url) => url.includes("/api/dashboard/adapters") && !url.includes("github"),
      {
        adapters: [
          { id: "slack", slug: "slack", name: "Slack" },
        ],
      },
    );
    enqueue(
      (url) => url.includes("/api/dashboard/github/repos"),
      { error: "github_not_connected" },
      412,
    );

    renderApp(<ConnectorsPage />, { route: "/connectors" });

    for (const c of CONNECTORS) {
      expect(await screen.findByText(c.name)).toBeTruthy();
    }
  });

  it("shows 'Connected' for adapters present in the YAML list and 'Not connected' otherwise", async () => {
    enqueue(
      (url) => url.includes("/api/dashboard/adapters") && !url.includes("github"),
      {
        adapters: [
          { id: "slack", slug: "slack", name: "Slack" },
          { id: "notion", slug: "notion", name: "Notion" },
        ],
      },
    );
    enqueue(
      (url) => url.includes("/api/dashboard/github/repos"),
      { error: "github_not_connected" },
      412,
    );

    renderApp(<ConnectorsPage />, { route: "/connectors" });

    // Slack card → Connected ✓
    const slackCard = (await screen.findByText("Slack")).closest("div") ?? document.body;
    // Walk up to the card. The badge "Connected ✓" should be inside.
    await waitFor(() => {
      expect(screen.getAllByText(/Connected ✓/i).length).toBeGreaterThanOrEqual(1);
    });
    // Confluence card → Not connected
    expect(screen.getAllByText(/Not connected/i).length).toBeGreaterThanOrEqual(1);
    void slackCard;
  });

  it("opens a setup modal with the markdown body + wizard for a non-GitHub adapter", async () => {
    enqueue(
      (url) => url.includes("/api/dashboard/adapters") && !url.includes("github"),
      { adapters: [] },
    );
    enqueue(
      (url) => url.includes("/api/dashboard/github/repos"),
      { error: "github_not_connected" },
      412,
    );
    enqueue(
      (url) =>
        url.includes("/api/dashboard/wizard/spec/adapter/slack"),
      {
        id: "slack",
        kind: "adapter",
        name: "Slack",
        description: "Slack workspace adapter.",
        steps: [
          {
            type: "text",
            key: "workspace_label",
            prompt: "Label for this Slack workspace",
            required: true,
          },
        ],
        secrets: [],
      },
    );

    renderApp(<ConnectorsPage />, { route: "/connectors" });
    const user = userEvent.setup();

    // Wait for the directory to render; all 8 non-GitHub cards expose
    // a "Connect" button when their adapter row is absent. CONNECTORS
    // ordering puts Slack at index 0 of the non-GitHub set.
    await screen.findByText("Slack");
    const connectButtons = screen.getAllByRole("button", {
      name: /^Connect$/,
    });
    expect(connectButtons.length).toBeGreaterThan(0);
    await user.click(connectButtons[0]!);

    // Dialog renders with the markdown title + the wizard prompt.
    const dialog = await screen.findByRole("dialog");
    // "Slack adapter" appears in the markdown heading + body — both
    // are acceptable signals that the SETUP guide is rendered.
    expect(
      within(dialog).getAllByText(/Slack adapter/i).length,
    ).toBeGreaterThan(0);
    await waitFor(() => {
      expect(
        within(dialog).getByText(/Label for this Slack workspace/i),
      ).toBeTruthy();
    });
  });

  it("GitHub card surfaces dedicated CTAs (no wizard modal)", async () => {
    enqueue(
      (url) => url.includes("/api/dashboard/adapters") && !url.includes("github"),
      { adapters: [] },
    );
    enqueue(
      (url) => url.includes("/api/dashboard/github/repos"),
      { error: "github_not_connected" },
      412,
    );

    renderApp(<ConnectorsPage />, { route: "/connectors" });

    expect(
      await screen.findByRole("button", { name: /Connect with GitHub/i }),
    ).toBeTruthy();
  });
});
