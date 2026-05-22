/**
 * Tiny zero-dependency markdown → HTML renderer used by the Connectors
 * directory to display each adapter's `SETUP.md` inline. Deliberately
 * narrow — supports only the subset the SETUP guides actually use:
 *
 *   - # / ## / ### headings
 *   - paragraphs separated by blank lines
 *   - unordered (`-` / `*`) and ordered (`1.`) lists
 *   - **bold**, _italic_, `inline code`
 *   - ```fenced code blocks```
 *   - [link text](href) — `target="_blank"` + safe `rel`
 *   - reference-style links of the form `[label][slug]` paired with a
 *     trailing `[slug]: https://…` definition list
 *
 * Why roll our own: pulling in `marked` or `markdown-it` would bloat the
 * SPA bundle for a feature that renders 9 stable docs. We escape HTML
 * before applying any transforms, so the output is XSS-safe even when
 * a future adapter author writes `<script>` in their guide. The function
 * is a pure mapping over the input string; the consumer uses
 * `dangerouslySetInnerHTML` to inject it.
 */

interface RefLink {
  href: string;
  title?: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Strip reference-style link definitions from the body and return them
 * as a lookup table keyed by lowercased slug. The body returned no
 * longer contains the `[slug]: href "title"` lines so they don't show
 * up as paragraphs.
 */
function extractReferences(input: string): {
  body: string;
  refs: Record<string, RefLink>;
} {
  const refs: Record<string, RefLink> = {};
  const lines: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(
      /^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+"([^"]+)")?\s*$/,
    );
    if (match) {
      const slug = match[1]!.toLowerCase();
      const href = match[2]!;
      const title = match[3];
      refs[slug] = title ? { href, title } : { href };
    } else {
      lines.push(line);
    }
  }
  return { body: lines.join("\n"), refs };
}

function renderInline(input: string, refs: Record<string, RefLink>): string {
  // Inline code first — its contents escape so we don't accidentally
  // re-process backticks inside other patterns.
  let out = input.replace(/`([^`]+)`/g, (_m, code: string) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Inline links: [text](href "title")
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g,
    (_m, text: string, href: string, title?: string) => {
      const safeHref = escapeHtml(href);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  );

  // Reference-style links: [text][slug] or [slug][]
  out = out.replace(
    /\[([^\]]+)\]\[([^\]]*)\]/g,
    (_m, text: string, slug: string) => {
      const key = (slug || text).toLowerCase();
      const ref = refs[key];
      if (!ref) return `[${text}]`;
      const titleAttr = ref.title ? ` title="${escapeHtml(ref.title)}"` : "";
      return `<a href="${escapeHtml(ref.href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  );

  // Bold (** … **) then italic (* … * / _ … _). Order matters so bold
  // wins over the single-asterisk italic rule on the same span.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<em>$1</em>");

  return out;
}

/**
 * Render the supported markdown subset to an HTML string suitable for
 * `dangerouslySetInnerHTML`. Input is escaped before any transforms so
 * the renderer can never inject unintended tags.
 */
export function renderMarkdown(input: string): string {
  if (!input) return "";
  const { body, refs } = extractReferences(input);
  // Escape the entire body first; the regex rules below re-emit safe
  // tags. This means any literal "<", ">", "&" in prose stays escaped.
  const escaped = escapeHtml(body);
  const lines = escaped.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      out.push(`<pre${langAttr}><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = renderInline(heading[2]!, refs);
      out.push(`<h${level}>${text}</h${level}>`);
      i += 1;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      out.push(
        `<ul>${buf
          .map((item) => `<li>${renderInline(item, refs)}</li>`)
          .join("")}</ul>`,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(
        `<ol>${buf
          .map((item) => `<li>${renderInline(item, refs)}</li>`)
          .join("")}</ol>`,
      );
      continue;
    }

    // Blank line — paragraph separator
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // Paragraph (consume contiguous non-blank, non-block lines)
    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim().length > 0 &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^```/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i += 1;
    }
    out.push(`<p>${renderInline(buf.join(" "), refs)}</p>`);
  }

  return out.join("\n");
}
