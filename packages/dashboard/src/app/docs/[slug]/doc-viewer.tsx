"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useTheme } from "next-themes";
import Link from "next/link";

interface DocViewerProps {
  markdown: string;
}

/**
 * Renders a markdown doc with GitHub-flavored styling. Layout, heading
 * borders, tables, blockquotes, code-block surfaces, and inline code
 * pills come from `github-markdown-css/github-markdown.css` (imported
 * once in globals.css). Code-block syntax highlighting comes from
 * `rehype-highlight`; the resulting `.hljs-*` classes are mapped onto
 * github-markdown-css's `--color-prettylights-syntax-*` variables in
 * globals.css so they auto-swap with the theme.
 *
 * `data-theme` is forwarded based on next-themes' resolved theme so
 * github-markdown-css picks the matching color set even when the user
 * has toggled away from their OS preference.
 *
 * Internal `./X.md` and `X.md` relative links rewrite to
 * `/docs/<slug>` so cross-references inside the docs/ folder navigate
 * within the dashboard.
 */
export function DocViewer({ markdown }: DocViewerProps): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  // useTheme returns undefined on the server; fall back to "light" so
  // the SSR HTML is deterministic. The class on <html> handles the
  // visual flash; this attribute just steers github-markdown-css when
  // it differs from prefers-color-scheme.
  const dataTheme: "light" | "dark" =
    resolvedTheme === "dark" ? "dark" : "light";

  return (
    <div className="markdown-body" data-theme={dataTheme}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children, ...props }) => {
            const target = href ?? "";
            const internal = rewriteInternalLink(target);
            if (internal) {
              return (
                <Link href={internal}>
                  {children}
                </Link>
              );
            }
            const isExternal = /^https?:\/\//i.test(target);
            return (
              <a
                href={target}
                {...(isExternal
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Rewrites links that point at sibling .md files in the docs/ folder to
 * the dashboard's `/docs/<slug>` route. Returns the rewritten path, or
 * `undefined` if the link should be passed through as-is.
 *
 * Handles patterns like:
 *   ./MCP-STACK.md           → /docs/MCP-STACK
 *   MCP-STACK.md             → /docs/MCP-STACK
 *   ../docs/USING.md         → /docs/USING
 *   docs/SETUP.md            → /docs/SETUP
 */
function rewriteInternalLink(href: string): string | undefined {
  if (!href || /^https?:\/\//i.test(href) || href.startsWith("#")) {
    return undefined;
  }
  const match = href.match(/(?:^|\/)([A-Za-z0-9._-]+)\.md(#.*)?$/);
  if (!match) return undefined;
  const slug = match[1];
  const hash = match[2] ?? "";
  return `/docs/${slug}${hash}`;
}
