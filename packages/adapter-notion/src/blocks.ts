/**
 * Notion block tree → markdown.
 *
 * Notion pages are built from a recursive tree of blocks. Each block has
 * a `type` and a matching property bag (e.g. `heading_1`, `paragraph`).
 * Text fragments are "rich text" arrays with annotations (bold, italic,
 * code, strikethrough, color) and optional links.
 *
 * This converter handles the common block types; unknowns degrade to
 * whatever plain text we can extract from their rich_text.
 */

export interface NotionRichText {
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    underline?: boolean;
  };
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: unknown;
}

export function blocksToMarkdown(blocks: NotionBlock[]): string {
  return blocks
    .map((b) => renderBlock(b, 0))
    .filter((s) => s.length > 0)
    .join("\n\n")
    .trim();
}

function renderBlock(block: NotionBlock, depth: number): string {
  const data = block[block.type] as Record<string, unknown> | undefined;
  const rich =
    (data?.rich_text as NotionRichText[] | undefined) ??
    (data?.text as NotionRichText[] | undefined) ??
    [];
  const text = renderRichText(rich);
  const children = block.children ?? [];
  const childText = children
    .map((c) => renderBlock(c, depth + 1))
    .filter((s) => s.length > 0)
    .join("\n");

  switch (block.type) {
    case "paragraph":
      return text + (childText ? `\n${indent(childText, depth + 1)}` : "");
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `${"  ".repeat(depth)}- ${text}${childText ? `\n${indentList(childText, depth + 1)}` : ""}`;
    case "numbered_list_item":
      return `${"  ".repeat(depth)}1. ${text}${childText ? `\n${indentList(childText, depth + 1)}` : ""}`;
    case "to_do": {
      const checked = Boolean(data?.checked);
      return `${"  ".repeat(depth)}- [${checked ? "x" : " "}] ${text}`;
    }
    case "toggle":
      return `${"  ".repeat(depth)}- ${text}${childText ? `\n${indentList(childText, depth + 1)}` : ""}`;
    case "quote":
      return text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "callout": {
      const icon = data?.icon as { emoji?: string } | undefined;
      const prefix = icon?.emoji ? `${icon.emoji} ` : "";
      return `> ${prefix}${text}`;
    }
    case "code": {
      const lang =
        ((data?.language as string) ?? "").replace(/\s/g, "") || "";
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case "divider":
      return "---";
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = (data?.url as string | undefined) ?? "";
      return url ? `<${url}>` : "";
    }
    case "child_page": {
      const title = (data?.title as string | undefined) ?? "";
      return title ? `📄 **${title}**` : "";
    }
    case "child_database": {
      const title = (data?.title as string | undefined) ?? "";
      return title ? `🗂️ **${title}**` : "";
    }
    case "equation": {
      const expr = (data?.expression as string | undefined) ?? "";
      return expr ? `\`${expr}\`` : "";
    }
    case "table":
    case "table_row":
      return text + (childText ? `\n${childText}` : "");
    default:
      // Unknown type — surface the text if any, keep children.
      return text + (childText ? `\n${indent(childText, depth + 1)}` : "");
  }
}

function renderRichText(nodes: NotionRichText[]): string {
  return nodes
    .map((n) => {
      let s = n.plain_text;
      const a = n.annotations ?? {};
      if (a.code) s = `\`${s}\``;
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strikethrough) s = `~~${s}~~`;
      if (n.href) s = `[${s}](${n.href})`;
      return s;
    })
    .join("");
}

function indent(text: string, depth: number): string {
  const pad = "  ".repeat(depth);
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

function indentList(text: string, depth: number): string {
  // Children of list items: keep them as nested list indentation.
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? "  ".repeat(depth) + l.trimStart() : l))
    .join("\n");
}
