/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import styles from './depth-motion.module.css';

/*
 * The wrapper that switches style sample H's in-page motion on. The server HTML is always the finished, readable
 * state; after mounting, when the visitor has not asked for reduced motion, the wrapper gets `data-motion="on"`
 * and then:
 *  - every `data-reveal` element below it starts hidden and plays in once (`data-in`) when it scrolls into view;
 *  - on a mouse, the `data-tilt` card under the pointer leans toward it and shows a sheen where the pointer is.
 * Scroll-scrubbed depth (`depthClass`) and the first screen's entrance are plain CSS and need no JavaScript.
 */

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const finePointer = () => Boolean(window.matchMedia?.('(hover: hover) and (pointer: fine)').matches);

/** How far a tilt card leans, in degrees, when the pointer is at its edge. */
export const TILT_MAX = 6;

/** The lean for a pointer at (x, y) inside a rect: rotateX from the vertical offset, rotateY from the horizontal. */
export function tiltFor(x: number, y: number, rect: { left: number; top: number; width: number; height: number }) {
  const dx = Math.min(1, Math.max(0, (x - rect.left) / Math.max(rect.width, 1)));
  const dy = Math.min(1, Math.max(0, (y - rect.top) / Math.max(rect.height, 1)));
  return { rx: (0.5 - dy) * 2 * TILT_MAX, ry: (dx - 0.5) * 2 * TILT_MAX, gx: dx * 100, gy: dy * 100 };
}

export function DepthStage({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let observer: IntersectionObserver | null = null;
    let frame = 0;
    let card: HTMLElement | null = null;
    let last = { x: 0, y: 0 };

    const lean = () => {
      frame = 0;
      if (!card) return;
      const { rx, ry, gx, gy } = tiltFor(last.x, last.y, card.getBoundingClientRect());
      card.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
      card.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
      card.style.setProperty('--gx', `${gx.toFixed(1)}%`);
      card.style.setProperty('--gy', `${gy.toFixed(1)}%`);
    };
    const release = () => {
      if (!card) return;
      for (const name of ['--rx', '--ry', '--gx', '--gy']) card.style.removeProperty(name);
      delete card.dataset.hover;
      card = null;
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const target = (event.target as Element | null)?.closest<HTMLElement>('[data-tilt]') ?? null;
      if (target !== card) {
        release();
        card = target;
        if (card) card.dataset.hover = 'on';
      }
      last = { x: event.clientX, y: event.clientY };
      if (card && !frame) frame = requestAnimationFrame(lean);
    };

    const stop = () => {
      observer?.disconnect();
      observer = null;
      cancelAnimationFrame(frame);
      frame = 0;
      release();
      root.removeEventListener('pointermove', onPointer);
      root.removeEventListener('pointerleave', release);
      delete root.dataset.motion;
    };
    const start = () => {
      if (root.dataset.motion || reducedMotion()) return;
      if (typeof IntersectionObserver !== 'undefined') {
        observer = new IntersectionObserver(entries => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            (entry.target as HTMLElement).dataset.in = '';
            observer?.unobserve(entry.target);
          }
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
        root.querySelectorAll<HTMLElement>('[data-reveal]').forEach(node => {
          if (!('in' in node.dataset)) observer?.observe(node);
        });
      }
      root.dataset.motion = 'on';
      if (finePointer()) {
        root.addEventListener('pointermove', onPointer, { passive: true });
        root.addEventListener('pointerleave', release);
      }
    };
    const onPreference = () => (reducedMotion() ? stop() : start());
    start();
    media?.addEventListener?.('change', onPreference);
    return () => {
      stop();
      media?.removeEventListener?.('change', onPreference);
    };
  }, []);

  return <div ref={ref} className={cn(styles.root, className)}>{children}</div>;
}
