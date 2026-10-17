/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import backdrop from './backdrop-j.module.css';
import styles from './j.module.css';

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Sample J's page wrapper. The server HTML is the finished page; after mounting, when motion is welcome, it sets
 * `data-motion="on"` and marks each voice-wall row `data-in` as it scrolls into view (CSS plays the note, then the
 * answer). Without JavaScript or with reduced motion nothing is hidden.
 * It also draws the backdrop and tracks which module (`data-zone` on a section) is in the middle of the screen, so
 * the backdrop's light follows the page (with reduced motion too; only the gliding stops).
 */
export function MotionJ({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const zones = new IntersectionObserver(entries => {
      const hit = entries.find(entry => entry.isIntersecting);
      const zone = (hit?.target as HTMLElement | undefined)?.dataset.zone;
      if (zone) root.dataset.zone = zone;
    }, { rootMargin: '-50% 0px -50% 0px' });
    root.querySelectorAll<HTMLElement>('[data-zone]').forEach(node => zones.observe(node));
    return () => zones.disconnect();
  }, []);
  useEffect(() => {
    const root = ref.current;
    if (!root || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      // Rows that come into view together still play one after another, top to bottom.
      entries.filter(entry => entry.isIntersecting).forEach((entry, order) => {
        const node = entry.target as HTMLElement;
        node.style.setProperty('--stagger', `${order * 220}ms`);
        node.dataset.in = '';
        observer.unobserve(node);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.15 });
    root.querySelectorAll<HTMLElement>('[data-row]').forEach(node => observer.observe(node));
    root.dataset.motion = 'on';
    return () => { observer.disconnect(); delete root.dataset.motion; };
  }, []);
  return (
    <div ref={ref} className={className} data-zone="hero">
      <div className={backdrop.backdrop} aria-hidden="true">
        <div className={backdrop.grid} />
        <span className={cn(backdrop.pool, backdrop.paper)} />
        <span className={cn(backdrop.pool, backdrop.cool)} />
        <span className={cn(backdrop.pool, backdrop.gold)} />
      </div>
      {children}
    </div>
  );
}

/**
 * The voice wall's "看另外 N 条" on a phone (on every screen with `always`): folds the list once mounted, one press
 * unfolds it for good.
 */
export function WallMoreJ({ listId, hiddenCount, always = false }: { listId: string; hiddenCount: number; always?: boolean }) {
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    const list = document.getElementById(listId);
    if (!list) return;
    list.dataset.folded = '';
    setFolded(true);
  }, [listId]);
  if (!folded) return null;
  const unfold = () => {
    const list = document.getElementById(listId);
    if (list) delete list.dataset.folded;
    setFolded(false);
  };
  return (
    <button type="button" className={styles.wallMore} data-always={always || undefined} aria-controls={listId} aria-expanded="false" onClick={unfold}>
      看另外 {hiddenCount} 条<ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}
