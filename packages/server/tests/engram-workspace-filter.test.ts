import { describe, expect, it } from "vitest";
import { filterByWorkspace, type EngramMemory } from "../src/clients/engram.js";

/**
 * The workspace filter is the only bit of session scoping that actually
 * touches search results. Legacy memories (ingested pre-session-scoping)
 * have no `workspace:*` tag and MUST remain findable — the cost of
 * hiding them would be a silent regression for anyone who upgrades.
 *
 * Workspace is encoded as a `workspace:<slug>` tag (not a nested
 * metadata field) because engram exposes tags on search results but
 * doesn't model workspace natively.
 */
function mem(id: string, workspace?: string): EngramMemory {
  return {
    id,
    content: `m-${id}`,
    ...(workspace !== undefined ? { tags: [`workspace:${workspace}`] } : {}),
  };
}

describe("filterByWorkspace", () => {
  it("returns the input unchanged when no workspace filter is given", () => {
    const input = [mem("1", "onenomad"), mem("2"), mem("3", "acme")];
    expect(filterByWorkspace(input, undefined)).toBe(input);
  });

  it("keeps memories whose workspace matches", () => {
    const input = [mem("1", "onenomad"), mem("2", "acme")];
    const out = filterByWorkspace(input, "onenomad");
    expect(out.map((m) => m.id)).toEqual(["1"]);
  });

  it("drops memories with a mismatched workspace", () => {
    const input = [mem("1", "acme"), mem("2", "onenomad")];
    const out = filterByWorkspace(input, "onenomad");
    expect(out.map((m) => m.id)).toEqual(["2"]);
  });

  it("keeps memories with no workspace field (legacy / pre-scoping ingests)", () => {
    const input = [mem("1"), mem("2", "onenomad"), mem("3", "acme")];
    const out = filterByWorkspace(input, "onenomad");
    // id 1 kept because it's legacy; id 2 matches; id 3 dropped.
    expect(out.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("handles missing tags array (treats as legacy)", () => {
    const raw: EngramMemory = { id: "bare", content: "x" };
    expect(filterByWorkspace([raw], "any-slug").map((m) => m.id)).toEqual([
      "bare",
    ]);
  });

  it("treats tag array without a workspace:* entry as legacy", () => {
    const tagged: EngramMemory = {
      id: "other-tags",
      content: "x",
      tags: ["project:foo", "cortex_type:note"],
    };
    // No workspace:* tag = pre-scoping ingest, keep it.
    expect(
      filterByWorkspace([tagged], "anything").map((m) => m.id),
    ).toEqual(["other-tags"]);
  });

  it("returns an empty array when nothing matches", () => {
    const input = [mem("1", "a"), mem("2", "b")];
    expect(filterByWorkspace(input, "c")).toEqual([]);
  });

  it("preserves order", () => {
    const input = [
      mem("1", "ws"),
      mem("2"),
      mem("3", "other"),
      mem("4", "ws"),
      mem("5"),
    ];
    expect(filterByWorkspace(input, "ws").map((m) => m.id)).toEqual([
      "1",
      "2",
      "4",
      "5",
    ]);
  });
});
