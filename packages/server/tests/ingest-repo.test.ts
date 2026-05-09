import { describe, expect, it } from "vitest";
import { isGitUrl } from "../src/mcp/tools/ingest-repo.js";

/**
 * Unit coverage for the git-URL detector. The shallowClone() helper
 * itself shells out to a real `git` binary; we don't unit-test the
 * spawn — that's an integration concern. The handler tests in the
 * existing suite catch the local-path walker behavior.
 *
 * The risk these tests guard against: misclassifying a local path as
 * a git URL (and trying to clone it) OR misclassifying a real git URL
 * as a local path (and getting "ENOENT" errors deep in the walker).
 *
 * Test fixtures use the github.com/user/ + github.com/foo/ placeholders
 * already allowlisted in scripts/identifier-scan-allow.txt.
 */
describe("ingest_repo: isGitUrl", () => {
  it("recognizes https git URLs", () => {
    expect(isGitUrl("https://github.com/user/repo")).toBe(true);
    expect(isGitUrl("https://github.com/user/repo.git")).toBe(true);
    expect(isGitUrl("http://github.com/foo/repo")).toBe(true);
  });

  it("recognizes ssh git URLs (git@host:path syntax)", () => {
    expect(isGitUrl("git@github.com:user/repo.git")).toBe(true);
    expect(isGitUrl("git@github.com:foo/proj")).toBe(true);
  });

  it("recognizes ssh:// git URLs", () => {
    expect(isGitUrl("ssh://git@github.com/user/repo.git")).toBe(true);
    expect(isGitUrl("ssh://git@github.com/user/repo")).toBe(true);
  });

  it("recognizes git:// URLs (rare but valid)", () => {
    expect(isGitUrl("git://github.com/user/repo.git")).toBe(true);
  });

  it("rejects local paths even when they look path-like", () => {
    expect(isGitUrl("/absolute/path/to/repo")).toBe(false);
    expect(isGitUrl("./relative/path")).toBe(false);
    expect(isGitUrl("relative/path")).toBe(false);
    expect(isGitUrl("C:\\Users\\foo\\repos\\x")).toBe(false);
    expect(isGitUrl("C:/Users/foo/repos/x")).toBe(false);
  });

  it("rejects local paths that contain 'github.com' as a directory name", () => {
    // Defensive: a local clone organized as ~/repos/github.com/user/repo/
    // is exactly the layout `gh repo clone` produces and `go get` favors.
    expect(isGitUrl("/Users/foo/repos/github.com/user/repo")).toBe(false);
    expect(isGitUrl("github.com/user/repo")).toBe(false);
  });

  it("rejects empty / nonsense input", () => {
    expect(isGitUrl("")).toBe(false);
    expect(isGitUrl("   ")).toBe(false);
    expect(isGitUrl("not a url and not a path")).toBe(false);
  });

  it("recognizes URLs with explicit case-variant scheme", () => {
    // RFC 3986: scheme is case-insensitive. We honor that even though
    // most callers use lowercase.
    expect(isGitUrl("HTTPS://github.com/user/repo")).toBe(true);
    expect(isGitUrl("Https://github.com/user/repo")).toBe(true);
  });
});
