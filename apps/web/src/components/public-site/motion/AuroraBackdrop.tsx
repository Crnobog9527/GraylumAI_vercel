/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { pageProgress } from './ScrollBackdrop';
import styles from './aurora-backdrop.module.css';

/*
 * Style sample H's backdrop: soft colored light flowing over a pale canvas, a perspective floor grid for depth,
 * and (on a mouse) a glow that follows the pointer. Fixed behind the page; render it once, first inside the page
 * wrapper, and give the content `position: relative`.
 *
 * The same idea as ScrollBackdrop: the page's scroll position (0 → 1) is written to `--scroll` once per frame and
 * scrubs paused keyframes, so the light moves through one continuous set of states from the top of the page to
 * the bottom. Each light also drifts slowly on its own. Everything animates transform or opacity only.
 * Without JavaScript, or with reduced motion, the backdrop holds its first state and nothing moves.
 */

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const finePointer = () => Boolean(window.matchMedia?.('(hover: hover) and (pointer: fine)').matches);

export function AuroraBackdrop({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    const spot = spotRef.current;
    if (!node || !spot) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let pointerFrame = 0;
    let pointer = { x: 0, y: 0 };
    let live = false;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => onScroll());
    const update = () => {
      frame = 0;
      const root = document.documentElement;
      node.style.setProperty('--scroll', pageProgress(window.scrollY, root.scrollHeight, window.innerHeight).toFixed(4));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const movePointer = () => {
      pointerFrame = 0;
      spot.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0)`;
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      pointer = { x: event.clientX, y: event.clientY };
      node.dataset.pointer = 'on';
      if (!pointerFrame) pointerFrame = requestAnimationFrame(movePointer);
    };
    const onLeave = () => { delete node.dataset.pointer; };
    const stop = () => {
      if (!live) return;
      live = false;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pointerFrame);
      frame = 0;
      pointerFrame = 0;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      resize?.disconnect();
      node.style.removeProperty('--scroll');
      spot.style.removeProperty('transform');
      delete node.dataset.motion;
      delete node.dataset.pointer;
    };
    const start = () => {
      if (live || reducedMotion()) return;
      live = true;
      node.dataset.motion = 'on';
      update();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      if (finePointer()) {
        window.addEventListener('pointermove', onPointer, { passive: true });
        document.documentElement.addEventListener('pointerleave', onLeave);
      }
      resize?.observe(document.body);
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
    <div ref={ref} aria-hidden="true" data-testid="aurora-backdrop" className={cn(styles.backdrop, className)}>
      <span className={cn(styles.light, styles.peach)}><i /></span>
      <span className={cn(styles.light, styles.lilac)}><i /></span>
      <span className={cn(styles.light, styles.aqua)}><i /></span>
      <span className={cn(styles.light, styles.gold)}><i /></span>
      <span className={styles.stream} />
      <span className={styles.floor}><i /></span>
      <span ref={spotRef} className={styles.spot} />
    </div>
  );
}
