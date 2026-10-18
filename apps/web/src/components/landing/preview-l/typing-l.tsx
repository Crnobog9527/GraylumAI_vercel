/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { COACH_CPS, typedCount } from '@/lib/landing/typing';
import styles from './typing-l.module.css';

/**
 * A picture that plays beat by beat holds its next beat while something in it is still being typed (round seven, T8):
 * every `useTyped` under the gate counts as busy until its text is whole.
 */
const TypingGate = createContext<{ begin: () => () => void } | null>(null);

export function useTypingGate() {
  const [busy, setBusy] = useState(0);
  const gate = useMemo(() => ({
    begin() {
      let open = true;
      setBusy(count => count + 1);
      return () => { if (open) { open = false; setBusy(count => count - 1); } };
    },
  }), []);
  const Provider = useMemo(() => function GateProvider({ children }: { children: ReactNode }) {
    return <TypingGate.Provider value={gate}>{children}</TypingGate.Provider>;
  }, [gate]);
  return { Provider, busy: busy > 0 };
}

const reducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * `text` typed out from when it first shows, about 35 characters a second, frame by frame (requestAnimationFrame);
 * `whole` (or reduced motion) shows it at once. `typing` is true until the last character.
 */
export function useTyped(text: string, { whole = false, cps = COACH_CPS }: { whole?: boolean; cps?: number } = {}) {
  const gate = useContext(TypingGate);
  const [count, setCount] = useState(whole ? text.length : 0);
  useEffect(() => {
    if (whole || reducedMotion()) { setCount(text.length); return; }
    setCount(0);
    const release = gate?.begin();
    const start = performance.now();
    let last = -1;
    let frame = 0;
    const tick = (now: number) => {
      const next = typedCount(now - start, text.length, cps);
      if (next !== last) { last = next; setCount(next); }
      if (next < text.length) frame = requestAnimationFrame(tick);
      else release?.();
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); release?.(); };
  }, [text, whole, cps, gate]);
  const shown = whole ? text.length : count;
  return { shown: text.slice(0, shown), typing: shown < text.length };
}

/** The blinking caret at the end of what is being typed. */
export function Caret() {
  return <i className={styles.caret} aria-hidden="true" />;
}

/** Wraps a Markdown message being typed: the caret follows its last character. */
export function TypingFrame({ typing, children }: { typing: boolean; children: ReactNode }) {
  return <div className={typing ? styles.typing : undefined}>{children}</div>;
}

/**
 * Keeps a scrolling conversation at its newest line while `enabled`, also while a message deeper down grows as it is
 * typed (a ResizeObserver on what it holds, since the typing re-renders only the message itself).
 */
export function useStickToEnd(scroller: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const node = scroller.current;
    if (!node || !enabled || typeof ResizeObserver === 'undefined') return;
    const stick = () => { node.scrollTop = node.scrollHeight; };
    stick();
    const observer = new ResizeObserver(stick);
    for (const child of Array.from(node.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [scroller, enabled]);
}
