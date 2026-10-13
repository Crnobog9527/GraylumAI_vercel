/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Marks each `[data-reveal-row]` row inside as "shown" once it scrolls into view, so CSS can bring the
 * second half in after a pause. The server HTML has no data-reveal value, so nothing is hidden
 * before this runs, without JavaScript, or when the visitor prefers reduced motion.
 */
export function RevealOnScroll({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal-row]'));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).dataset.reveal = 'shown';
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -15% 0px' });
    for (const row of rows) {
      // No layout reads here: the wall sits in a content-visibility section that should stay unrendered.
      row.dataset.reveal = 'pending';
      observer.observe(row);
    }
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} className={className}>{children}</div>;
}
