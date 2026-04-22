import { describe, expect, it } from "vitest";
import { chunkCode } from "../src/chunk.js";
import { detectLanguage } from "../src/language.js";

describe("detectLanguage", () => {
  it("maps common extensions to a language label", () => {
    expect(detectLanguage("src/foo.ts")).toBe("typescript");
    expect(detectLanguage("main.py")).toBe("python");
    expect(detectLanguage("server.go")).toBe("go");
    expect(detectLanguage("Cargo.toml")).toBe("toml");
  });

  it("uses filename overrides for Dockerfile / Makefile", () => {
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("path/to/Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("Makefile")).toBe("makefile");
  });

  it("falls back to plaintext for unknown extensions", () => {
    expect(detectLanguage("thing.xyz")).toBe("plaintext");
    expect(detectLanguage("LICENSE")).toBe("plaintext");
  });
});

describe("chunkCode", () => {
  it("returns one chunk when content fits under maxChars", () => {
    const chunks = chunkCode("function hi() { return 1; }", {
      language: "typescript",
      maxChars: 1000,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(1);
  });

  it("splits on function boundaries in typescript", () => {
    const src = [
      "const header = 1;",
      "",
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "function beta() {",
      "  return 2;",
      "}",
      "",
      "class Gamma {",
      "  hi() { return 3; }",
      "}",
    ].join("\n");
    const chunks = chunkCode(src, {
      language: "typescript",
      maxChars: 50, // force a split
    });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Symbols captured for functions and class.
    const symbols = chunks.map((c) => c.symbol).filter(Boolean);
    expect(symbols).toContain("alpha");
    expect(symbols).toContain("beta");
    expect(symbols).toContain("Gamma");
  });

  it("applies fixed-window fallback when a chunk still exceeds maxChars", () => {
    // A single function much longer than the cap.
    const big = "function huge() {\n" + "  // line\n".repeat(200) + "}\n";
    const chunks = chunkCode(big, {
      language: "typescript",
      maxChars: 200,
      overlapChars: 40,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(300); // 200 + overlap carry
    }
  });

  it("splits python on def and class boundaries", () => {
    const py = [
      "import os",
      "",
      "def first():",
      "    return 1",
      "",
      "def second():",
      "    return 2",
      "",
      "class Third:",
      "    def go(self):",
      "        return 3",
    ].join("\n");
    const chunks = chunkCode(py, { language: "python", maxChars: 30 });
    const symbols = chunks.map((c) => c.symbol).filter(Boolean);
    expect(symbols).toContain("first");
    expect(symbols).toContain("second");
    expect(symbols).toContain("Third");
  });
});
