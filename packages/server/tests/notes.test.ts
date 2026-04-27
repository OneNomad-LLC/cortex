import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseNote,
  serializeNote,
  type NoteFrontmatter,
} from "../src/notes/frontmatter.js";
import { pickAvailableSlug, slugify } from "../src/notes/slug.js";
import {
  createNote,
  deleteNote,
  ensureNotesDir,
  getNote,
  listNotes,
  updateNote,
} from "../src/notes/repo.js";

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cortex-notes-test-"));
  const repo = { notesDir: dir };
  ensureNotesDir(repo);
  return {
    repo,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

/** Vault-flavored repo: cortex-notes lives at <vault>/cortex-notes/. */
function tmpVaultRepo() {
  const vaultPath = mkdtempSync(join(tmpdir(), "cortex-vault-test-"));
  const notesDir = join(vaultPath, "cortex-notes");
  const repo = { vaultPath, notesDir };
  ensureNotesDir(repo);
  return {
    repo,
    vaultPath,
    cleanup: () => {
      try { rmSync(vaultPath, { recursive: true, force: true }); } catch { /* nothing */ }
    },
  };
}

describe("slugify", () => {
  it("produces kebab-case from a Title Cased phrase", () => {
    expect(slugify("Thinking About The Roadmap")).toBe(
      "thinking-about-the-roadmap",
    );
  });

  it("strips punctuation + collapses whitespace", () => {
    expect(slugify("  Hello, World!  ")).toBe("hello-world");
  });

  it("falls back to 'untitled' on empty / all-stripped input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
  });

  it("handles unicode by stripping diacritics + non-ASCII", () => {
    // NFKD decomposes "é" → "e" + combining acute, the regex strips
    // the combining mark, the ASCII filter keeps the bare "e".
    expect(slugify("Café strategy")).toBe("cafe-strategy");
    // Genuinely non-decomposable non-ASCII (e.g. CJK) gets dropped.
    expect(slugify("中文 plan")).toBe("plan");
  });
});

describe("pickAvailableSlug", () => {
  it("returns the base when free", () => {
    expect(pickAvailableSlug("foo", () => false)).toBe("foo");
  });

  it("appends -2 on first collision", () => {
    const taken = new Set(["foo"]);
    expect(pickAvailableSlug("foo", (s) => taken.has(s))).toBe("foo-2");
  });

  it("walks up to first free suffix", () => {
    const taken = new Set(["foo", "foo-2", "foo-3"]);
    expect(pickAvailableSlug("foo", (s) => taken.has(s))).toBe("foo-4");
  });
});

describe("frontmatter parse + serialize roundtrip", () => {
  it("roundtrips title/project/tags/created/updated", () => {
    const fm: NoteFrontmatter = {
      slug: "x",
      title: "Hello",
      project: "alpha",
      tags: ["a", "b"],
      created: "2026-04-27T00:00:00.000Z",
      updated: "2026-04-27T01:00:00.000Z",
      source: "cortex-notes",
    };
    const text = serializeNote(fm, "Body");
    const parsed = parseNote(text);
    expect(parsed.frontmatter.slug).toBe("x");
    expect(parsed.frontmatter.title).toBe("Hello");
    expect(parsed.frontmatter.project).toBe("alpha");
    expect(parsed.frontmatter.tags).toEqual(["a", "b"]);
    expect(parsed.body.trim()).toBe("Body");
  });

  it("strips empty tags array on serialize so YAML stays clean", () => {
    const fm: NoteFrontmatter = {
      slug: "x",
      title: "y",
      tags: [],
      created: "2026-04-27T00:00:00.000Z",
      updated: "2026-04-27T00:00:00.000Z",
      source: "cortex-notes",
    };
    const text = serializeNote(fm, "");
    expect(text).not.toMatch(/tags:/);
  });

  it("rejects content without frontmatter", () => {
    expect(() => parseNote("just a body")).toThrow(/frontmatter/);
  });
});

describe("createNote", () => {
  it("writes a file with frontmatter + body", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const handle = createNote(repo, {
        title: "Roadmap",
        body: "Things to do.",
        project: "alpha",
        tags: ["q2"],
      });
      expect(handle.slug).toBe("roadmap");
      const text = readFileSync(handle.path, "utf8");
      const parsed = parseNote(text);
      expect(parsed.frontmatter.title).toBe("Roadmap");
      expect(parsed.frontmatter.project).toBe("alpha");
      expect(parsed.frontmatter.tags).toEqual(["q2"]);
      expect(parsed.body).toMatch(/Things to do\./);
    } finally {
      cleanup();
    }
  });

  it("picks the next slug on collision", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const a = createNote(repo, { title: "Notes", body: "" });
      const b = createNote(repo, { title: "Notes", body: "" });
      expect(a.slug).toBe("notes");
      expect(b.slug).toBe("notes-2");
    } finally {
      cleanup();
    }
  });
});

describe("updateNote", () => {
  it("idempotent — second update with same content is a no-op", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const fixedNow = () => new Date("2026-04-27T12:00:00.000Z");
      const a = createNote(repo, { title: "A", body: "x", now: fixedNow });
      const r1 = updateNote(repo, { slug: a.slug, body: "y", now: () => new Date("2026-04-27T13:00:00.000Z") });
      expect(r1.changed).toBe(true);
      const r2 = updateNote(repo, { slug: a.slug, body: "y", now: () => new Date("2026-04-27T14:00:00.000Z") });
      expect(r2.changed).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("bumps `updated` only when content actually changes", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const fixedNow = () => new Date("2026-04-27T12:00:00.000Z");
      const a = createNote(repo, { title: "A", body: "x", now: fixedNow });
      const before = parseNote(readFileSync(a.path, "utf8"));
      const r = updateNote(repo, {
        slug: a.slug,
        body: "x",
        now: () => new Date("2026-04-27T13:00:00.000Z"),
      });
      const after = parseNote(readFileSync(a.path, "utf8"));
      expect(r.changed).toBe(false);
      // updated ts unchanged
      expect(after.frontmatter.updated).toBe(before.frontmatter.updated);
    } finally {
      cleanup();
    }
  });

  it("throws on missing slug", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      expect(() => updateNote(repo, { slug: "nope" })).toThrow(/not found/);
    } finally {
      cleanup();
    }
  });
});

describe("deleteNote", () => {
  it("removes the file", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const a = createNote(repo, { title: "T", body: "" });
      const r = deleteNote(repo, a.slug);
      expect(r.deleted).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("idempotent on missing slug", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const r = deleteNote(repo, "nope");
      expect(r.deleted).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("listNotes", () => {
  it("returns metadata + preview, sorted by updated desc", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      createNote(repo, {
        title: "Older",
        body: "older body",
        now: () => new Date("2026-04-26T00:00:00.000Z"),
      });
      createNote(repo, {
        title: "Newer",
        body: "newer body".repeat(50),
        now: () => new Date("2026-04-27T00:00:00.000Z"),
      });
      const notes = listNotes(repo);
      expect(notes.length).toBe(2);
      expect(notes[0]!.title).toBe("Newer");
      expect(notes[1]!.title).toBe("Older");
      expect(notes[0]!.preview.length).toBeLessThanOrEqual(200);
    } finally {
      cleanup();
    }
  });

  it("filters by project", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      createNote(repo, { title: "alpha note", body: "", project: "alpha" });
      createNote(repo, { title: "beta note", body: "", project: "beta" });
      const filtered = listNotes(repo, { project: "alpha" });
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.title).toBe("alpha note");
    } finally {
      cleanup();
    }
  });

  it("respects limit", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      createNote(repo, { title: "A", body: "" });
      createNote(repo, { title: "B", body: "" });
      createNote(repo, { title: "C", body: "" });
      const first = listNotes(repo, { limit: 2 });
      expect(first.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("skips files without cortex-notes source frontmatter", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      // Drop a stray markdown file with no frontmatter.
      const strayPath = join(repo.notesDir, "stray.md");
      writeFileSync(strayPath, "# stray", "utf8");

      createNote(repo, { title: "real note", body: "" });
      const notes = listNotes(repo);
      expect(notes.length).toBe(1);
      expect(notes[0]!.title).toBe("real note");
    } finally {
      cleanup();
    }
  });

  it("federates: surfaces obsidian-authored notes from elsewhere in the vault", () => {
    const { repo, vaultPath, cleanup } = tmpVaultRepo();
    try {
      createNote(repo, { title: "Cortex one", body: "" });
      // Drop a hand-authored markdown at the vault root with loose frontmatter.
      writeFileSync(
        join(vaultPath, "ideas.md"),
        "---\ntitle: Random idea\ntags: [scratch]\n---\nA thought.\n",
        "utf8",
      );
      // And another, in a subdir, no frontmatter at all.
      mkdirSync(join(vaultPath, "daily"));
      writeFileSync(
        join(vaultPath, "daily", "2026-04-27.md"),
        "Standup notes go here.\n",
        "utf8",
      );

      const notes = listNotes(repo);
      const kinds = notes.map((n) => n.kind).sort();
      expect(kinds).toEqual(["cortex", "obsidian", "obsidian"]);

      const cortex = notes.find((n) => n.kind === "cortex");
      expect(cortex?.slug).toBe("cortex-one");
      expect(cortex?.id).toBe("cortex-one");

      const ideas = notes.find((n) => n.relativePath === "ideas.md");
      expect(ideas?.title).toBe("Random idea");
      expect(ideas?.tags).toEqual(["scratch"]);
      expect(ideas?.kind).toBe("obsidian");

      const daily = notes.find(
        (n) => n.relativePath === "daily/2026-04-27.md",
      );
      // Falls back to the filename when frontmatter is missing.
      expect(daily?.title).toBe("2026-04-27");
      expect(daily?.preview).toContain("Standup");
    } finally {
      cleanup();
    }
  });

  it("ignores .obsidian / .git / node_modules during the vault walk", () => {
    const { repo, vaultPath, cleanup } = tmpVaultRepo();
    try {
      mkdirSync(join(vaultPath, ".obsidian"));
      writeFileSync(join(vaultPath, ".obsidian", "config.md"), "# config", "utf8");
      mkdirSync(join(vaultPath, "node_modules", "junk"), { recursive: true });
      writeFileSync(
        join(vaultPath, "node_modules", "junk", "README.md"),
        "# noise",
        "utf8",
      );
      writeFileSync(join(vaultPath, "real.md"), "# real", "utf8");

      const notes = listNotes(repo);
      expect(notes.map((n) => n.relativePath).filter(Boolean)).toEqual([
        "real.md",
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("getNote", () => {
  it("reads a cortex note's full body", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      const a = createNote(repo, {
        title: "Hello",
        body: "This is the full body.",
        project: "alpha",
      });
      const read = getNote(repo, { kind: "cortex", slug: a.slug });
      expect(read.kind).toBe("cortex");
      expect(read.title).toBe("Hello");
      expect(read.body).toContain("This is the full body.");
      expect(read.project).toBe("alpha");
    } finally {
      cleanup();
    }
  });

  it("reads an obsidian note's body via relativePath", () => {
    const { repo, vaultPath, cleanup } = tmpVaultRepo();
    try {
      writeFileSync(
        join(vaultPath, "doc.md"),
        "---\ntitle: Doc\n---\nbody here\n",
        "utf8",
      );
      const read = getNote(repo, {
        kind: "obsidian",
        relativePath: "doc.md",
      });
      expect(read.kind).toBe("obsidian");
      expect(read.title).toBe("Doc");
      expect(read.body.trim()).toBe("body here");
    } finally {
      cleanup();
    }
  });

  it("rejects relativePaths that escape the vault", () => {
    const { repo, cleanup } = tmpVaultRepo();
    try {
      expect(() =>
        getNote(repo, { kind: "obsidian", relativePath: "../leak.md" }),
      ).toThrow(/invalid relativePath/);
      expect(() =>
        getNote(repo, { kind: "obsidian", relativePath: "/etc/passwd" }),
      ).toThrow(/invalid relativePath/);
    } finally {
      cleanup();
    }
  });

  it("throws on missing notes", () => {
    const { repo, cleanup } = tmpRepo();
    try {
      expect(() => getNote(repo, { kind: "cortex", slug: "ghost" })).toThrow(
        /not found/,
      );
    } finally {
      cleanup();
    }
  });
});
