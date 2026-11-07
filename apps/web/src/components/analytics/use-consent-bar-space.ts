/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, type RefObject } from 'react';

export const CONSENT_BAR_SPACE = '--consent-bar-space';

/**
 * While the consent bar shows, the space it takes at the bottom of the window (its height plus the gap below it) is set
 * on <html> as `--consent-bar-space`. The body pads its end by it and the full-height signed-in frames (workspace,
 * signed-in shell) shrink by it, so the bar never covers a button or the composer at the bottom (ANALYTICS-CONSENT).
 * Removed again when the bar goes.
 */
export function useConsentBarSpace(bar: RefObject<HTMLElement | null>, shown: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const node = bar.current;
    if (!shown || !node) {
      root.style.removeProperty(CONSENT_BAR_SPACE);
      return;
    }
    const measure = () => {
      const space = Math.max(0, Math.ceil(window.innerHeight - node.getBoundingClientRect().top));
      root.style.setProperty(CONSENT_BAR_SPACE, `${space}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty(CONSENT_BAR_SPACE);
    };
  }, [bar, shown]);
}
