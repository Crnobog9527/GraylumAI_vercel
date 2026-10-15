/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { pageProgress } from './ScrollBackdrop';
import { IStoryScene, IStorySky } from './IStoryScene';
import styles from './i-story-backdrop.module.css';

/*
 * Sample I's scroll-driven background: one line-drawn panorama along the bottom of the screen that tells the
 * story of one ordinary person making an account, from a blank profile (top of the page) to an account that is
 * running (bottom). The page's scroll position (0 → 1) is written to `--p` once per frame; the panorama, the
 * sky behind it and the warm light read that one variable, each at its own speed (layered parallax). Small
 * idle motions (breathing, bobbing, floating hearts) run in CSS once the page has loaded and gone idle: SVG
 * animations are painted on the main thread, so they must not compete with the first render. Without
 * JavaScript, or with reduced motion, the panorama stays on its first chapter and nothing moves.
 *
 * Same contract as ScrollBackdrop: render it once, first inside the page wrapper; page content sits above it.
 */

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

export function IStoryBackdrop({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let live = false;
    let ambient = 0;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => onScroll());
    const update = () => {
      frame = 0;
      const root = document.documentElement;
      node.style.setProperty('--p', pageProgress(window.scrollY, root.scrollHeight, window.innerHeight).toFixed(4));
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
      window.clearTimeout(ambient);
      node.style.removeProperty('--p');
      delete node.dataset.motion;
      delete node.dataset.ambient;
    };
    const start = () => {
      if (live || reducedMotion()) return;
      live = true;
      node.dataset.motion = 'on';
      update();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      resize?.observe(document.body);
      ambient = window.setTimeout(() => {
        const idle = window.requestIdleCallback ?? ((run: () => void) => run());
        idle(() => { if (live) node.dataset.ambient = 'on'; });
      }, document.readyState === 'complete' ? 1200 : 3000);
    };
    const onPreference = () => (reducedMotion() ? stop() : start());
    start();
    media?.addEventListener?.('change', onPreference);
    return () => {
      stop();
      media?.removeEventListener?.('change', onPreference);
    };
  }, []);

  return (
    <div ref={ref} aria-hidden="true" data-testid="i-story-backdrop" className={cn(styles.backdrop, className)}>
      <span className={styles.warm} />
      <div className={styles.skyTrack}><IStorySky className={styles.sky} /></div>
      <div className={styles.track}><IStoryScene className={styles.scene} /></div>
    </div>
  );
}
