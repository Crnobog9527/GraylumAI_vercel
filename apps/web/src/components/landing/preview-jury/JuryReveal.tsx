/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './jury-results.module.css';

/** Scrolling this far down past the last reveal opens the next chapter, so one flick never opens them all. */
const SCROLL_STEP = 140;

/**
 * Chapters open one at a time: by the button, or by scrolling down to the end of what is open. Nothing opens by
 * itself, so the page never grows while the user is reading.
 */
export function useReveal(total: number) {
  const [shown, setShown] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const more = useCallback(() => setShown(value => Math.min(total, value + 1)), [total]);
  const all = useCallback(() => setShown(total), [total]);
  const done = shown >= total;

  useEffect(() => {
    if (done) return;
    let last = window.scrollY;
    let travelled = 0;
    const onScroll = () => {
      const now = window.scrollY;
      travelled = now > last ? travelled + (now - last) : 0;
      last = now;
      const node = end.current;
      if (!node || travelled < SCROLL_STEP || node.getBoundingClientRect().top > window.innerHeight - 40) return;
      travelled = 0;
      more();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [done, more]);

  return { shown, more, all, done, end };
}

/** The control under the open chapters: open the next one, or all of them at once. */
export function RevealMore({ reveal, total, children }: {
  reveal: ReturnType<typeof useReveal>; total: number; children?: ReactNode;
}) {
  if (reveal.done) return null;
  return (
    <div className={styles.reveal} ref={reveal.end}>
      {children}
      <button type="button" className={styles.primary} onClick={reveal.more}>
        <ChevronDown size={16} aria-hidden="true" />
        {reveal.shown === 0 ? `逐章看（共 ${total} 章）` : `看下一章（${reveal.shown + 1}/${total}）`}
      </button>
      {total - reveal.shown > 1 ? <button type="button" className={styles.textButton} onClick={reveal.all}>全部展开</button> : null}
    </div>
  );
}
