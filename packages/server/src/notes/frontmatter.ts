import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * YAML frontmatter parser/serializer for cortex-authored notes.
 *
 * Format mirrors what the obsidian adapter already understands —
 * `--- ... ---` block at the top of the file, followed by a blank
 * line, followed by markdown body. The adapter reads the same
 * frontmatter for project/tags/etc. metadata, so cortex-notes flow
 * through the existing ingest pipeline without special casing.
 */

export interface NoteFrontmatter {
  slug: string;
  title: string;
  project?: string | undefined;
  tags?: string[] | undefined;
  created: string;
  updated: string;
  /** Discriminator — distinguishes cortex-notes from generic obsidian docs. */
  source: "cortex-notes";
  [extra: string]: unknown;
}

export interface ParsedNote {
  frontmatter: NoteFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseNote(raw: string): ParsedNote {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error("note: missing YAML frontmatter");
  }
  const [, fmRaw, body] = match;
  const fm = parseYaml(fmRaw ?? "") as unknown;
  if (!fm || typeof fm !== "object") {
    throw new Error("note: frontmatter is not an object");
  }
  const obj = fm as Record<string, unknown>;
  if (typeof obj.slug !== "string" || obj.slug.length === 0) {
    throw new Error("note: frontmatter.slug missing");
  }
  if (typeof obj.title !== "string") {
    throw new Error("note: frontmatter.title missing");
  }
  return {
    frontmatter: {
      ...obj,
      slug: obj.slug,
      title: obj.title,
      created: typeof obj.created === "string" ? obj.created : "",
      updated: typeof obj.updated === "string" ? obj.updated : "",
      source: "cortex-notes",
    } as NoteFrontmatter,
    body: body ?? "",
  };
}

export function serializeNote(fm: NoteFrontmatter, body: string): string {
  // Strip undefined keys before serialization so optional fields don't
  // round-trip as `tags: null` in the YAML.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    cleaned[k] = v;
  }
  const yaml = stringifyYaml(cleaned, { lineWidth: 0 }).trimEnd();
  // Always end on a single trailing newline so subsequent appends
  // don't fuse with the body's first line.
  const safeBody = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${yaml}\n---\n\n${safeBody}`;
}
