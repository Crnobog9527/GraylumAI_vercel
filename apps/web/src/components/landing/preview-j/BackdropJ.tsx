/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import backdrop from './backdrop-j.module.css';

/**
 * The home page's backdrop (backdrop-j.module.css): a faint grid and three pools of light, fixed behind the page. The pools
 * follow `data-zone` on an ancestor. MotionJ (the home page) tracks the zones itself; the other public pages (PublicShell,
 * Owner 2026-11-14 PUBLIC-SITE: "背景动效的匹配") pass `track`, and the backdrop then sets its parent's `data-zone` to the
 * `[data-zone]` section in the middle of the screen, the same way MotionJ does. With reduced motion the pools still follow
 * but jump instead of gliding (the stylesheet's own rule); without JavaScript the page keeps its first light.
 */
export function BackdropJ({ track = false }: { track?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current?.parentElement;
    if (!track || !root || typeof IntersectionObserver === 'undefined') return;
    const zones = new IntersectionObserver(entries => {
      const hit = entries.find(entry => entry.isIntersecting);
      const zone = (hit?.target as HTMLElement | undefined)?.dataset.zone;
      if (zone) root.dataset.zone = zone;
    }, { rootMargin: '-50% 0px -50% 0px' });
    root.querySelectorAll<HTMLElement>('[data-zone]').forEach(node => zones.observe(node));
    return () => zones.disconnect();
  }, [track]);
  return (
    <div ref={ref} className={backdrop.backdrop} aria-hidden="true">
      <div className={backdrop.grid} />
      <span className={cn(backdrop.pool, backdrop.paper)} />
      <span className={cn(backdrop.pool, backdrop.cool)} />
      <span className={cn(backdrop.pool, backdrop.gold)} />
    </div>
  );
}
