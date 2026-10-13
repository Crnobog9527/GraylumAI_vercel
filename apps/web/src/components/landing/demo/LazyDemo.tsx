/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { DEMO_LABEL, DEMO_NOTE } from './demo-script';
import styles from './demo.module.css';

/**
 * Loads the demo's code only when the visitor scrolls near it, so the first screen does not pay for the
 * Markdown renderer and the conversation components. The placeholder keeps the same height (no layout shift).
 */
export function LazyDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [Demo, setDemo] = useState<ComponentType | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let cancelled = false;
    const load = () => {
      void import('./DemoWorkspace').then(module => { if (!cancelled) setDemo(() => module.DemoWorkspace); });
    };
    if (typeof IntersectionObserver === 'undefined') { load(); return () => { cancelled = true; }; }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: '600px 0px' });
    observer.observe(node);
    return () => { cancelled = true; observer.disconnect(); };
  }, []);

  if (Demo) return <Demo />;
  return (
    <div ref={ref} className={styles.window} aria-busy="true">
      <div className={styles.chrome}><span className={styles.badge}>{DEMO_LABEL}</span><p>{DEMO_NOTE}</p></div>
    </div>
  );
}
