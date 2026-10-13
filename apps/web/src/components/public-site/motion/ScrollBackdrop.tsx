/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import styles from './scroll-backdrop.module.css';

/*
 * The public site's one scroll-driven background (Owner, 2026-10-14): a gold glow inside an orbit ring,
 * fixed behind the page, that unfolds through the same states from the top of any page to its bottom.
 * Every public page uses it the same way: render <ScrollBackdrop /> once, first inside the page wrapper,
 * and give the page content `position: relative` so it sits above it. Nothing here knows about a page.
 *
 * Progress is the page's scroll position (0 at the top, 1 at the bottom), written to `--scroll` once per frame.
 * The states are CSS keyframes held paused and scrubbed with a negative animation-delay, so one variable drives
 * every layer in every browser. Without JavaScript, or when the visitor asks for reduced motion, the backdrop
 * stays in its first state and never moves.
 */

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

export function pageProgress(scrollY: number, scrollHeight: number, viewHeight: number) {
  const range = scrollHeight - viewHeight;
  if (range <= 0) return 0;
  return Math.min(1, Math.max(0, scrollY / range));
}

export function ScrollBackdrop({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let live = false;
    // Sections rendered late (content-visibility, lazy demos) change the page height without a scroll event.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => onScroll());
    const update = () => {
      frame = 0;
      const root = document.documentElement;
      node.style.setProperty('--scroll', pageProgress(window.scrollY, root.scrollHeight, window.innerHeight).toFixed(4));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const stop = () => {
      if (!live) return;
      live = false;
      cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      resize?.disconnect();
      node.style.removeProperty('--scroll');
      delete node.dataset.motion;
    };
    const start = () => {
      if (live || reducedMotion()) return;
      live = true;
      node.dataset.motion = 'on';
      update();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      resize?.observe(document.body);
    };
    // The visitor can switch reduced motion on while the page is open; the backdrop follows.
    const onPreference = () => (reducedMotion() ? stop() : start());
    start();
    media?.addEventListener?.('change', onPreference);
    return () => {
      stop();
      media?.removeEventListener?.('change', onPreference);
    };
  }, []);

  return (
    <div ref={ref} aria-hidden="true" data-testid="scroll-backdrop" className={cn(styles.backdrop, className)}>
      <span className={styles.dots} />
      <span className={styles.glow} />
      <span className={styles.ring} />
    </div>
  );
}
