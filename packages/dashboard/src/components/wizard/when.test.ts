/**
 * Coverage for the hand-rolled `when` evaluator. The verb list is
 * closed; if a new verb gets added, add a case here.
 */

import { describe, expect, it } from "vitest";
import { evaluateWhen, type WhenPredicate } from "./when";

describe("evaluateWhen", () => {
  const a = { kind: "slack", count: 3, channels: ["C1", "C2"], name: "" };

  it("undefined predicate → visible", () => {
    expect(evaluateWhen(undefined, a)).toBe(true);
  });

  it("boolean predicates short-circuit", () => {
    expect(evaluateWhen(true, a)).toBe(true);
    expect(evaluateWhen(false, a)).toBe(false);
  });

  it("eq / neq exact-match comparison", () => {
    expect(evaluateWhen({ eq: ["kind", "slack"] }, a)).toBe(true);
    expect(evaluateWhen({ eq: ["kind", "loom"] }, a)).toBe(false);
    expect(evaluateWhen({ neq: ["kind", "loom"] }, a)).toBe(true);
    expect(evaluateWhen({ eq: ["count", 3] }, a)).toBe(true);
  });

  it("in matches any listed value", () => {
    expect(evaluateWhen({ in: ["kind", ["slack", "loom"]] }, a)).toBe(true);
    expect(evaluateWhen({ in: ["kind", ["loom", "obsidian"]] }, a)).toBe(false);
  });

  it("not-empty distinguishes truthy / empty for strings + arrays + records", () => {
    expect(evaluateWhen({ "not-empty": "channels" }, a)).toBe(true);
    expect(evaluateWhen({ "not-empty": "name" }, a)).toBe(false);
    expect(evaluateWhen({ "not-empty": "missing" }, a)).toBe(false);
    expect(evaluateWhen({ "not-empty": "kind" }, a)).toBe(true);
    expect(evaluateWhen({ "not-empty": "count" }, a)).toBe(true);
  });

  it("and is short-circuit conjunction", () => {
    const p: WhenPredicate = {
      and: [
        { eq: ["kind", "slack"] },
        { "not-empty": "channels" },
      ],
    };
    expect(evaluateWhen(p, a)).toBe(true);
    expect(
      evaluateWhen(
        { and: [{ eq: ["kind", "slack"] }, { eq: ["count", 99] }] },
        a,
      ),
    ).toBe(false);
  });

  it("or is disjunction across predicates", () => {
    const p: WhenPredicate = {
      or: [{ eq: ["kind", "loom"] }, { eq: ["count", 3] }],
    };
    expect(evaluateWhen(p, a)).toBe(true);
    expect(
      evaluateWhen(
        { or: [{ eq: ["kind", "loom"] }, { eq: ["count", 99] }] },
        a,
      ),
    ).toBe(false);
  });

  it("not inverts the inner predicate", () => {
    expect(evaluateWhen({ not: { eq: ["kind", "slack"] } }, a)).toBe(false);
    expect(evaluateWhen({ not: { eq: ["kind", "loom"] } }, a)).toBe(true);
  });

  it("composes nested verbs", () => {
    const pred: WhenPredicate = {
      and: [
        { not: { eq: ["kind", "loom"] } },
        { or: [{ "not-empty": "channels" }, { eq: ["count", 0] }] },
      ],
    };
    expect(evaluateWhen(pred, a)).toBe(true);
  });

  it("unknown shapes default to visible (forward-compat)", () => {
    expect(
      evaluateWhen(
        { "future-verb": "kind" } as unknown as WhenPredicate,
        a,
      ),
    ).toBe(true);
  });
});
