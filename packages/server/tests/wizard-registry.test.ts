import { describe, expect, it } from "vitest";
import { listWizards, findWizard, wizardsByCategory } from "../src/cli/wizard-registry.js";

describe("wizard-registry", () => {
  it("exposes a wizard for every module that supports guided setup", () => {
    const ids = listWizards().map((w) => w.id).sort();
    expect(ids).toEqual([
      "bitbucket",
      "confluence",
      "github",
      "gmail",
      "google-calendar",
      "google-drive",
      "jira",
      "linear",
      "loom",
      "notion",
      "obsidian",
      "ollama",
      "openrouter",
      "pgvector",
      "slack",
      "webhooks",
    ]);
  });

  it("every wizard has required metadata and at least one step", () => {
    for (const w of listWizards()) {
      expect(w.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(w.name.length).toBeGreaterThan(0);
      expect(w.description.length).toBeGreaterThan(0);
      expect(["adapter", "provider", "memory", "toolkit", "webhook"]).toContain(w.category);
      expect(w.steps.length).toBeGreaterThan(0);
      expect(typeof w.configSchema.safeParse).toBe("function");
    }
  });

  it("all step keys within a wizard are unique (top-level)", () => {
    for (const w of listWizards()) {
      const keys = w.steps.map((s) => s.key);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      expect(dupes, `${w.id}: duplicate step keys`).toEqual([]);
    }
  });

  it("findWizard returns undefined for unknown ids and the module for known ones", () => {
    expect(findWizard("jira")?.id).toBe("jira");
    expect(findWizard("does-not-exist")).toBeUndefined();
  });

  it("groups every wizard under its category", () => {
    const buckets = wizardsByCategory();
    const adapters = buckets.get("adapter") ?? [];
    const providers = buckets.get("provider") ?? [];
    const memories = buckets.get("memory") ?? [];
    const webhooks = buckets.get("webhook") ?? [];
    // Every listed wizard lands in exactly one bucket.
    const total = adapters.length + providers.length + memories.length + webhooks.length;
    expect(total).toBe(listWizards().length);
    expect(adapters.length).toBeGreaterThan(0);
    expect(providers.length).toBeGreaterThan(0);
  });

  it("repeat-per steps point at a source key that produces a list earlier in the spec", () => {
    for (const w of listWizards()) {
      const seenListKeys = new Set<string>();
      for (const step of w.steps) {
        if (step.type === "list") seenListKeys.add(step.key);
        if (step.type === "repeat-per") {
          expect(
            seenListKeys.has(step.source),
            `${w.id}.${step.key}: repeat-per source "${step.source}" must be a list step that appears earlier`,
          ).toBe(true);
        }
      }
    }
  });
});
