"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";

import { cn } from "@/lib/utils";

interface DocViewerProps {
  markdown: string;
}

/**
 * Renders a markdown doc with prose styling. Internal `./X.md` and `X.md`
 * relative links rewrite to `/docs/<slug>` so cross-references inside the
 * docs/ folder navigate within the dashboard.
 */
export function DocViewer({ markdown }: DocViewerProps): React.JSX.Element {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => {
            const target = href ?? "";
            const internal = rewriteInternalLink(target);
            if (internal) {
              return (
                <Link href={internal} className="text-primary hover:underline">
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
                className="text-primary hover:underline"
                {...props}
              >
                {children}
              </a>
            );
          },
          code: ({ className, children, ...props }) => {
            // ReactMarkdown passes block code with a `language-*` class on
            // the <code> nested in <pre>, and inline code with no class. We
            // want a tighter inline style and let prose handle blocks.
            const isInline = !className?.includes("language-");
            return (
              <code
                className={cn(
                  isInline &&
                    "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
                  className,
                )}
                {...props}
              >
                {children}
              </code>
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
