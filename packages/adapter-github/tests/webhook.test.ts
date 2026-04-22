import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubWebhook } from "../src/webhook.js";

const SECRET = "shhh";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

describe("createGithubWebhook", () => {
  const handler = createGithubWebhook({
    secret: SECRET,
    includeGlobs: ["**/*.ts", "**/README*"],
    excludeGlobs: ["**/node_modules/**"],
    repoToProject: { "owner/repo": "alpha" },
  });

  it("rejects when signature header is missing", async () => {
    const result = await handler.verify({
      method: "POST",
      path: "/webhooks/github",
      headers: {},
      rawBody: "{}",
    });
    expect(result).toEqual({ ok: false, reason: "missing x-hub-signature-256" });
  });

  it("rejects when signature doesn't match", async () => {
    const result = await handler.verify({
      method: "POST",
      path: "/webhooks/github",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      rawBody: "{}",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a correctly-signed body", async () => {
    const body = JSON.stringify({ hello: "world" });
    const result = await handler.verify({
      method: "POST",
      path: "/webhooks/github",
      headers: { "x-hub-signature-256": sign(body) },
      rawBody: body,
    });
    expect(result).toEqual({ ok: true });
  });

  it("parses a push payload into glob-filtered RawSourceItems", async () => {
    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "owner/repo" },
      commits: [
        {
          id: "abc123",
          added: ["src/new-feature.ts", "README.md"],
          modified: ["node_modules/ignored.ts"],
          removed: [],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const items = await handler.parse({
      method: "POST",
      path: "/webhooks/github",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "push",
      },
      rawBody: body,
    });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.sourceId).sort()).toEqual([
      "github:owner/repo@main:README.md",
      "github:owner/repo@main:src/new-feature.ts",
    ]);
    for (const item of items) {
      const raw = item.raw as Record<string, unknown>;
      expect(raw._webhook).toBe(true);
      expect(raw.sha).toBe("abc123");
      expect(raw.branch).toBe("main");
    }
  });

  it("dedupes paths seen across multiple commits in the same push", async () => {
    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "owner/repo" },
      commits: [
        { id: "c1", added: ["src/a.ts"], modified: [] },
        { id: "c2", added: [], modified: ["src/a.ts"] },
      ],
    };
    const body = JSON.stringify(payload);
    const items = await handler.parse({
      method: "POST",
      path: "/webhooks/github",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "push",
      },
      rawBody: body,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceId).toBe("github:owner/repo@main:src/a.ts");
  });

  it("ignores non-push events", async () => {
    const body = JSON.stringify({
      repository: { full_name: "owner/repo" },
      ref: "refs/heads/main",
    });
    const items = await handler.parse({
      method: "POST",
      path: "/webhooks/github",
      headers: {
        "x-hub-signature-256": sign(body),
        "x-github-event": "ping",
      },
      rawBody: body,
    });
    expect(items).toEqual([]);
  });

  it("refuses to construct when secret is empty", () => {
    expect(() =>
      createGithubWebhook({
        secret: "",
        includeGlobs: ["**/*"],
        excludeGlobs: [],
        repoToProject: {},
      }),
    ).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });
});
