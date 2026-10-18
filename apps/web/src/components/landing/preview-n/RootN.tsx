/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './n.module.css';

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Each region's key cell, in the order the frame meets them: a cell marked `data-key`, the comparison's first pair
 * (CompareJ is shared, so it is found by its region name) and the recommended plan (PlanCardsMNO's data attributes).
 */
const KEYS = '[data-key], [data-zone="compare"] [data-region="对比卡片"], [data-plan][data-recommended]';
/** Where the frame rests when motion is off: the recommended plan. */
const RESTING = '[data-plan][data-recommended]';
/** How far outside the cell the frame's corners sit (the gap between cells is 14px). */
const OUT = 7;

/**
 * Sample N's page root (direction E, Owner 2026-10-17), in place of sample J's MotionJ (no light pools: plain warm
 * canvas). The server HTML is the finished page. After mounting, with motion welcome, it sets `data-motion="on"`
 * and marks each cell (`data-cell`) and each comparison row (`data-row`) `data-in` as it scrolls into view; cells
 * that arrive together fade in 40ms apart. Its one continuous element is the gold selection frame: four corners that
 * glide (transform only) to the key cell of whichever region crosses the middle of the screen, and stay put between
 * regions. With reduced motion the frame simply sits on the recommended plan.
 */
export function RootN({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      entries.filter(entry => entry.isIntersecting).forEach((entry, order) => {
        const node = entry.target as HTMLElement;
        // Comparison rows keep sample J's beat; cells follow one another 40ms apart.
        node.style.setProperty('--stagger', `${order * 220}ms`);
        node.style.setProperty('--cell-at', `${order * 40}ms`);
        node.dataset.in = '';
        observer.unobserve(node);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.12 });
    root.querySelectorAll<HTMLElement>('[data-row], [data-cell]').forEach(node => observer.observe(node));
    root.dataset.motion = 'on';
    return () => { observer.disconnect(); delete root.dataset.motion; };
  }, []);

  useEffect(() => {
    const root = ref.current;
    const box = frame.current;
    if (!root || !box) return;
    let target: HTMLElement | null = null;
    let settle = 0;
    const place = () => {
      if (!target || !target.isConnected) return;
      const cell = target.getBoundingClientRect();
      const base = root.getBoundingClientRect();
      box.style.setProperty('--x', `${cell.left - base.left - OUT}px`);
      box.style.setProperty('--y', `${cell.top - base.top - OUT}px`);
      box.style.setProperty('--w', `${cell.width + OUT * 2}px`);
      box.style.setProperty('--h', `${cell.height + OUT * 2}px`);
      box.dataset.on = '';
    };
    const pick = (next: HTMLElement | undefined) => {
      if (!next || next === target) return;
      if (target) delete target.dataset.picked;
      target = next;
      target.dataset.picked = '';
      place();
      // A cell still fading in sits 12px low; measure again once it has landed.
      window.clearTimeout(settle);
      settle = window.setTimeout(place, 600);
    };

    let zones: IntersectionObserver | null = null;
    if (reducedMotion() || typeof IntersectionObserver === 'undefined') {
      pick(root.querySelector<HTMLElement>(RESTING) ?? undefined);
    } else {
      const keyOf = new Map<Element, HTMLElement>();
      root.querySelectorAll<HTMLElement>(KEYS).forEach(key => {
        const zone = key.closest('[data-zone]');
        if (zone && !keyOf.has(zone)) keyOf.set(zone, key);
      });
      zones = new IntersectionObserver(entries => {
        const hit = entries.find(entry => entry.isIntersecting);
        if (hit) pick(keyOf.get(hit.target));
      }, { rootMargin: '-45% 0px -45% 0px' });
      keyOf.forEach((_, zone) => zones?.observe(zone));
    }
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    resized?.observe(root);
    window.addEventListener('resize', place);
    return () => {
      zones?.disconnect();
      resized?.disconnect();
      window.removeEventListener('resize', place);
      window.clearTimeout(settle);
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      <div ref={frame} className={styles.frame} aria-hidden="true">
        <i data-c="tl" /><i data-c="tr" /><i data-c="bl" /><i data-c="br" />
      </div>
      {children}
    </div>
  );
}
