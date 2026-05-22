import { describe, expect, it } from "vitest";

import { CONNECTORS, findConnector } from "./connectors";

const EXPECTED_IDS = [
  "github",
  "slack",
  "notion",
  "confluence",
  "jira",
  "bitbucket",
  "linear",
  "loom",
  "obsidian",
] as const;

describe("CONNECTORS catalog", () => {
  it("exposes exactly the 9 in-scope adapters", () => {
    expect(CONNECTORS.map((c) => c.id).sort()).toEqual(
      [...EXPECTED_IDS].sort(),
    );
  });

  it("marks only GitHub as supporting the OAuth flow", () => {
    const oauthIds = CONNECTORS.filter((c) => c.oauthFlow).map((c) => c.id);
    expect(oauthIds).toEqual(["github"]);
  });

  it("includes non-empty setup markdown for every connector", () => {
    for (const c of CONNECTORS) {
      expect(c.setupMarkdown.length).toBeGreaterThan(100);
      expect(c.setupMarkdown.startsWith("#")).toBe(true);
    }
  });

  it("findConnector() resolves by id and returns undefined for unknown", () => {
    expect(findConnector("github")?.name).toBe("GitHub");
    expect(findConnector("nope")).toBeUndefined();
  });
});
