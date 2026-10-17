/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { createContext, createElement, useContext, type HTMLAttributes, type ReactNode } from 'react';

/**
 * The shared display components (positioning, work conversation, library, jury) are the product's own, and on a public
 * page they appear as examples inside the page's own content (SEO_GEO_SPEC section 6: one H1, H2s that are real
 * questions, no heading tags for card titles). `DisplayHeading` is the heading of those components: in the product it is
 * the real h1–h4 it always was; inside `<AsDemo>` it is a `div` that looks the same (the style sheets name
 * `[data-demo-heading]` next to the tag, see the `:is(h2, :where([data-demo-heading="h2"]))` selectors).
 */
const DemoContext = createContext(false);

/** Wrap an example of a product screen: everything inside renders its headings as plain elements. */
export function AsDemo({ children }: { children: ReactNode }) {
  return <DemoContext.Provider value>{children}</DemoContext.Provider>;
}

export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4';

export function DisplayHeading({ as, children, ...rest }: { as: HeadingLevel; children?: ReactNode } & HTMLAttributes<HTMLElement>) {
  const demo = useContext(DemoContext);
  return demo
    ? createElement('div', { 'data-demo-heading': as, ...rest }, children)
    : createElement(as, rest, children);
}
