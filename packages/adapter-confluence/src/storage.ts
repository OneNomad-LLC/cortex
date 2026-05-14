/**
 * Convert Confluence "storage" format (XHTML-ish with ac: macros) into
 * plain markdown good enough for ingestion.
 *
 * This is deliberately simple. Confluence's storage format is XHTML plus
 * a handful of Atlassian-specific macros. The goal here isn't a perfect
 * round-trip — pipelines just need readable prose plus preserved heading
 * structure and lists.
 *
 * Approach:
 * - Strip/replace common tags with markdown equivalents
 * - Drop macros we don't understand, keep their inner text
 * - Collapse whitespace
 *
 * When the content is already requested as `atlas_doc_format` or
 * `view` HTML, it will still pass through cleanly; unknown tags are
 * dropped with their text preserved.
 */
export function storageToMarkdown(storage: string): string {
  let out = storage;

  // Code blocks first (CDATA we don't want to touch).
  out = out.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
    (_m, code) => `\n\n\`\`\`\n${code}\n\`\`\`\n\n`,
  );

  // Inline formatting BEFORE block containers so emphasis inside <li>/<h*>
  // survives the stripInline pass used for those block collapsers.
  out = out.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => `**${stripInline(t)}**`);
  out = out.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => `*${stripInline(t)}*`);
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${stripInline(t)}\``);
  out = out.replace(
    /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, text) => `[${stripInline(text)}](${href})`,
  );

  // Headings.
  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, text) => {
    const lvl = Number.parseInt(level, 10);
    return `\n\n${"#".repeat(lvl)} ${stripInline(text)}\n\n`;
  });

  // Lists.
  out = out.replace(/<ul[^>]*>/gi, "\n").replace(/<\/ul>/gi, "\n");
  out = out.replace(/<ol[^>]*>/gi, "\n").replace(/<\/ol>/gi, "\n");
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text) => {
    return `- ${stripInline(text)}\n`;
  });

  // Paragraphs and breaks.
  out = out.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  out = out.replace(/<p[^>]*>/gi, "").replace(/<\/p>/gi, "\n\n");
  out = out.replace(/<br\s*\/?>/gi, "\n");

  // Any remaining ac: macros — strip the wrapper but keep inner text.
  out = out.replace(/<ac:[^>]+>/gi, "").replace(/<\/ac:[^>]+>/gi, "");
  out = out.replace(/<ri:[^>]+\/>/gi, "");

  // Drop any other HTML tags.
  out = out.replace(/<[^>]+>/g, "");

  // Decode basic HTML entities.
  out = decodeEntities(out);

  // Collapse excess whitespace.
  out = out.replace(/\n{3,}/g, "\n\n").trim();

  return out;
}

function stripInline(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
