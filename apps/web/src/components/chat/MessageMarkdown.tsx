/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { DisplayHeading, type HeadingLevel } from "@/components/chat-display/display-heading";
import { cn } from "@/lib/utils";
import { closePartialMarkdown, isAppMessageHref, remarkSoftBreaks, safeMessageHref } from "./message-markdown-source";
import styles from "./message-markdown.module.css";

// Model text is data: raw HTML is skipped, images are shown as their alt text
// (no third-party loads from a reply), and only http(s)/mailto links survive.
const components: Components = {
  a: ({ href, children }) =>
    href && isAppMessageHref(href) ? (
      <a href={href}>{children}</a>
    ) : href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }) => (
    <div className={styles.tableScroll}>
      <table>{children}</table>
    </div>
  ),
  // The same h1–h4 as always; inside a public page's example (<AsDemo>) plain elements that look the same (SEO_GEO_SPEC
  // section 6), so a report shown as an example adds no headings to the page.
  ...Object.fromEntries((["h1", "h2", "h3", "h4"] as HeadingLevel[]).map(level => [
    level, ({ children }: { children?: ReactNode }) => <DisplayHeading as={level}>{children}</DisplayHeading>,
  ])),
};

const plugins = [remarkGfm, remarkSoftBreaks];

/** Formatted body for an assistant/model message. User messages stay plain text. */
export function MessageMarkdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(styles.body, className)} data-message-markdown="">
      <Markdown
        remarkPlugins={plugins}
        components={components}
        skipHtml
        urlTransform={safeMessageHref}
      >
        {streaming ? closePartialMarkdown(text) : text}
      </Markdown>
    </div>
  );
}
