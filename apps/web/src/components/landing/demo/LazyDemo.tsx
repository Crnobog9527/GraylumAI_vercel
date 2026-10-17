/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { DemoWorkspace } from './DemoWorkspace';
import { DEMO_LABEL, DEMO_NOTE } from './demo-script';
import styles from './demo.module.css';

/**
 * Loads the demo's code only when the visitor scrolls near it, so the first screen does not pay for the
 * Markdown renderer and the conversation components. The placeholder keeps the same height (no layout shift).
 * `start` is passed through to the demo. Opened on the step summary, it plays by itself, so it mounts only once it
 * is well inside the screen; the full demo loads early instead, since it waits for the visitor anyway.
 */
export function LazyDemo({ start }: { start?: 'beginning' | 'summary' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [Demo, setDemo] = useState<ComponentType<Parameters<typeof DemoWorkspace>[0]> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let cancelled = false;
    const load = () => {
      import('./DemoWorkspace')
        .then(module => { if (!cancelled) setDemo(() => module.DemoWorkspace); })
        .catch(() => { if (!cancelled) setFailed(true); });
    };
    if (typeof IntersectionObserver === 'undefined') { load(); return () => { cancelled = true; }; }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: start === 'summary' ? '0px 0px -25% 0px' : '600px 0px' });
    observer.observe(node);
    return () => { cancelled = true; observer.disconnect(); };
  }, [start]);

  if (Demo) return <Demo start={start} />;
  return (
    <div ref={ref} className={styles.window} aria-busy={!failed}>
      <div className={styles.chrome}><span className={styles.badge}>{DEMO_LABEL}</span><p>{DEMO_NOTE}</p></div>
      {failed ? <p role="status" className={styles.failed}>演示没有加载出来，请刷新页面再试。</p> : null}
    </div>
  );
}
