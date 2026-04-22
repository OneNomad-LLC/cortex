import { describe, expect, it } from "vitest";
import { matchesGlobs } from "../src/glob.js";

describe("matchesGlobs", () => {
  it("matches simple extension includes", () => {
    expect(matchesGlobs("src/foo.ts", ["**/*.ts"])).toBe(true);
    expect(matchesGlobs("src/foo.js", ["**/*.ts"])).toBe(false);
  });

  it("exclude overrides include", () => {
    expect(
      matchesGlobs("node_modules/pkg/foo.ts", ["**/*.ts"], ["**/node_modules/**"]),
    ).toBe(false);
  });

  it("includes anything when include list is empty", () => {
    expect(matchesGlobs("random.xyz", [])).toBe(true);
  });

  it("normalizes Windows-style separators", () => {
    expect(matchesGlobs("src\\nested\\file.ts", ["**/*.ts"])).toBe(true);
  });

  it("supports ? single-character wildcard", () => {
    expect(matchesGlobs("a.txt", ["?.txt"])).toBe(true);
    expect(matchesGlobs("ab.txt", ["?.txt"])).toBe(false);
  });
});
