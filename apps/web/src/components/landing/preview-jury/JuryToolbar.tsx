/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import styles from './jury.module.css';

/** One toolbar for everything: the stage below it fills the rest of the window, so its height is published as --j-bar. */
export function Toolbar({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = bar.current;
    const page = node?.parentElement;
    if (!node || !page) return;
    const publish = () => page.style.setProperty('--j-bar', `${Math.ceil(node.getBoundingClientRect().height)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className={styles.toolbar} ref={bar}>
      <div className={styles.toolRow}>{children}</div>
    </div>
  );
}
