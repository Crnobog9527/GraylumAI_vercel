/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId } from 'react';
import { cn } from '@/lib/utils';
import styles from './i-reveal.module.css';

/*
 * Sample I's section transitions. Give a section `data-i-reveal` and `reveal.section`; its children with
 * `reveal.rise` (or `reveal.pop`) then come in one after another with a short spring, ordered by their `--d`
 * style value, when the section reaches the screen, and each road between sections draws itself.
 * <IRevealRoot /> (once per page) arms this only when JavaScript runs and reduced motion is off, so without
 * either everything is simply there.
 */

export const reveal = { section: styles.reveal, rise: styles.rise, pop: styles.pop };

export function IRevealRoot() {
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-i-reveal]'));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).dataset.iIn = '';
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });
    for (const node of nodes) {
      // A section already on screen when the page opens is simply there; only later ones animate in.
      if (node.getBoundingClientRect().top < window.innerHeight * 0.88) continue;
      node.dataset.iReady = '';
      observer.observe(node);
    }
    return () => observer.disconnect();
  }, []);
  return null;
}

/** The dashed road between two sections: drawn when it reaches the screen, ending in a pin that pops in. */
export function IRoad({ flip = false, className }: { flip?: boolean; className?: string }) {
  const maskId = `i-road-${useId().replace(/:/g, '')}`;
  const d = flip
    ? 'M4 18 C220 18 260 66 520 58 S900 10 1196 52'
    : 'M4 52 C240 60 300 8 600 20 S980 66 1196 22';
  return (
    <div data-i-reveal="" aria-hidden="true" className={cn(styles.reveal, styles.roadWrap, className)}>
      <svg viewBox="0 0 1200 72" preserveAspectRatio="none" className={styles.road} focusable="false">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <path d={d} className={styles.roadMask} pathLength={1} />
          </mask>
        </defs>
        <path d={d} className={styles.roadLine} mask={`url(#${maskId})`} />
      </svg>
      <span className={styles.pin} data-flip={flip} />
    </div>
  );
}
