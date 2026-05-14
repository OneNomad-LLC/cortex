/**
 * Atlassian Document Format → markdown.
 *
 * ADF is a JSON tree; each node has a `type` and optional `content`/`text`
 * children. We handle the common types seen in Jira issue bodies:
 *   paragraph, heading, bulletList, orderedList, listItem, text,
 *   hardBreak, link/mention/emoji marks, codeBlock, blockquote, rule.
 *
 * Unknown node types are walked as containers (their content is emitted),
 * so future additions degrade to plain text rather than vanishing.
 */

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

export function adfToMarkdown(doc: AdfNode | undefined | null): string {
  if (!doc) return "";
  return render(doc).trim();
}

function render(node: AdfNode, depth = 0): string {
  const children = () =>
    (node.content ?? []).map((c) => render(c, depth)).join("");

  switch (node.type) {
    case "doc":
      return children();

    case "paragraph":
      return `${children()}\n\n`;

    case "heading": {
      const lvl = clamp(Number(node.attrs?.level ?? 1), 1, 6);
      return `${"#".repeat(lvl)} ${children()}\n\n`;
    }

    case "hardBreak":
      return "\n";

    case "rule":
      return "\n---\n\n";

    case "blockquote":
      return (
        (node.content ?? [])
          .map((c) => `> ${render(c, depth).trim()}`)
          .join("\n") + "\n\n"
      );

    case "bulletList":
      return renderList(node, "-");

    case "orderedList":
      return renderList(node, "1.");

    case "listItem": {
      const inner = children().trim();
      return inner;
    }

    case "codeBlock": {
      const lang = (node.attrs?.language as string | undefined) ?? "";
      return `\n\`\`\`${lang}\n${plainText(node)}\n\`\`\`\n\n`;
    }

    case "text":
      return applyMarks(node.text ?? "", node.marks);

    case "mention": {
      const name = (node.attrs?.text as string | undefined) ?? "@user";
      return name;
    }

    case "emoji":
      return (node.attrs?.text as string | undefined) ?? "";

    case "inlineCard":
    case "link": {
      const href = (node.attrs?.href ?? node.attrs?.url ?? "") as string;
      const label = children() || href;
      return `[${label}](${href})`;
    }

    default:
      return children();
  }
}

function renderList(node: AdfNode, bullet: string): string {
  const items = (node.content ?? []).map((item, i) => {
    const marker = bullet === "1." ? `${i + 1}.` : bullet;
    const body = render(item).trim();
    return `${marker} ${body}`;
  });
  return items.join("\n") + "\n\n";
}

function applyMarks(text: string, marks: AdfNode["marks"]): string {
  let out = text;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "link": {
        const href = mark.attrs?.href as string | undefined;
        if (href) out = `[${out}](${href})`;
        break;
      }
      case "strike":
        out = `~~${out}~~`;
        break;
      default:
        // Leave unknown marks as plain text.
        break;
    }
  }
  return out;
}

function plainText(node: AdfNode): string {
  if (node.text) return node.text;
  return (node.content ?? []).map(plainText).join("");
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
