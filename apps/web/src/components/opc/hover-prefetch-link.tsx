/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import Link from 'next/link';

/*
 * A link whose page is fetched ahead only while the visitor points at it.
 *
 * The signed-in links carry `prefetch={false}` (#1392, DB-100): fetching every link on screen ahead cost 8 to 25 page
 * requests on each page load, most for pages nobody opened. The price is that a click starts from nothing: measured on
 * staging (2026-11-12), 资料库 shows 1.2 s after the click, 0.07 s when its page was already fetched.
 *
 * This is Next's own "hover-triggered prefetch" (node_modules/next/dist/docs/01-app/02-guides/prefetching.md): `prefetch`
 * is `false` until the pointer rests on the link, a key reaches it, or a finger touches it, and `null` (Next's default)
 * while it does; it goes back to `false` when the pointer or the focus leaves, so a link that was pointed at once is
 * not kept fresh for the rest of the visit.
 *
 * For the handful of fixed entries of the rail only. Rows of a list (conversations, drafts) stay `prefetch={false}`:
 * the pointer crosses many of them on its way somewhere else.
 */

/** How long the pointer or the focus stays on the link before its page is fetched: moving across it fetches nothing. */
export const HOVER_PREFETCH_DWELL_MS = 80;

type LinkProps = ComponentProps<typeof Link>;
type Props = Omit<LinkProps, 'prefetch' | 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'onTouchStart'>;

export function HoverPrefetchLink(props: Props) {
  const [pointedAt, setPointedAt] = useState(false);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (dwell.current) clearTimeout(dwell.current); dwell.current = null; };
  const arrive = () => { cancel(); dwell.current = setTimeout(() => setPointedAt(true), HOVER_PREFETCH_DWELL_MS); };
  const leave = () => { cancel(); setPointedAt(false); };
  useEffect(() => cancel, []);
  // A touch is followed by the click at once: no dwell.
  return <Link {...props} prefetch={pointedAt ? null : false} onMouseEnter={arrive} onMouseLeave={leave} onFocus={arrive} onBlur={leave}
    onTouchStart={() => { cancel(); setPointedAt(true); }}/>;
}
