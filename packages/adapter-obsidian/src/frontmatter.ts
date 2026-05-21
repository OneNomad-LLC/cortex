/**
 * Parse simple YAML-ish frontmatter without pulling a full YAML parser
 * (that lives in @onenomad/przm-cortex-server). Supports the subset Obsidian users
 * actually write:
 *   - scalar keys: `title: Foo`, `date: 2026-04-22`
 *   - flow arrays: `tags: [a, b, c]`
 *   - block arrays (one `- item` per line)
 *   - quoted strings (single or double)
 *
 * Returns { metadata, body }. Missing or malformed frontmatter returns
 * the whole text as body and an empty metadata object — never throws.
 */

export interface ParsedFrontmatter {
  metadata: Record<string, string | string[]>;
  body: string;
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  if (!source.startsWith("---")) {
    return { metadata: {}, body: source };
  }
  const end = source.indexOf("\n---", 3);
  if (end < 0) return { metadata: {}, body: source };

  const block = source.slice(3, end).trim();
  const rest = source.slice(end + 4);
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;

  const metadata: Record<string, string | string[]> = {};
  const lines = block.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.startsWith("#")) {
      i++;
      continue;
    }
    const match = /^([A-Za-z0-9_\- ]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const [, keyRaw, rawValue] = match;
    if (!keyRaw) {
      i++;
      continue;
    }
    const key = keyRaw.trim();
    const value = (rawValue ?? "").trim();

    if (value === "" && i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1] ?? "")) {
      // Block array follows.
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s*-\s/.test(lines[i] ?? "")) {
        const item = (lines[i] ?? "").replace(/^\s*-\s*/, "");
        items.push(stripQuotes(item.trim()));
        i++;
      }
      metadata[key] = items;
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      const items = inner
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      metadata[key] = items;
    } else {
      metadata[key] = stripQuotes(value);
    }
    i++;
  }

  return { metadata, body };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
