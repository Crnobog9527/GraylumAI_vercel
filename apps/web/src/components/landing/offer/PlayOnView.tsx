/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Plays a walk-through mock once when it scrolls into view (flow.module.css). The server HTML has no
 * data-play value, so the finished state shows before hydration, without JavaScript, and with reduced motion.
 */
export function PlayOnView({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = ref.current;
    if (!stage || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    stage.dataset.play = 'ready';
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      stage.dataset.play = 'on';
      observer.disconnect();
    }, { rootMargin: '0px 0px -20% 0px' });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} className={className}>{children}</div>;
}
