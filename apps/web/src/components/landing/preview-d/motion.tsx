/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import styles from './d.module.css';

/*
 * Sample D's scroll motion. The server HTML is always the finished state (full ink, filled rail, final digits);
 * a component only switches to its animated state after mounting, when the visitor has not asked for reduced
 * motion. Nothing is hidden without JavaScript.
 */

const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

type Measure = (rect: DOMRect, view: number) => number;

/** Calls `onProgress` once per frame while scrolling, with `measure` clamped to 0 → 1. */
function useScrollProgress(ref: RefObject<HTMLElement | null>, measure: Measure, onProgress: (progress: number) => void) {
  const callbacks = useRef({ measure, onProgress });
  callbacks.current = { measure, onProgress };
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion()) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const value = callbacks.current.measure(node.getBoundingClientRect(), window.innerHeight);
      callbacks.current.onProgress(Math.min(1, Math.max(0, value)));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ref]);
}

// The paragraph is fully inked by the time its top reaches a third of the screen.
const paragraphProgress: Measure = (rect, view) => (view * 0.85 - rect.top) / (view * 0.5);
// The rail follows the line at 60% of the screen down the list.
const railProgress: Measure = (rect, view) => (view * 0.6 - rect.top) / Math.max(rect.height, 1);

/**
 * The promise paragraph fills from grey to ink, character by character, as it scrolls up the screen.
 * Screen readers get the sentence once, from a visually hidden copy.
 */
export function InkFill({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const chars = Array.from(text);
  useScrollProgress(ref, paragraphProgress, progress => {
    const node = ref.current;
    if (!node) return;
    node.dataset.fill = 'live';
    const lit = Math.round(progress * chars.length);
    node.querySelectorAll<HTMLElement>('[data-ch]').forEach((span, index) => {
      span.dataset.on = index < lit ? '1' : '0';
    });
  });
  return (
    <p ref={ref} className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{chars.map((char, index) => <span key={index} data-ch="">{char}</span>)}</span>
    </p>
  );
}

/** The nine-step timeline: its rail fills with scroll and each step's marker turns ink when reached. */
export function StepRail({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLOListElement>(null);
  useScrollProgress(ref, railProgress, progress => {
    const node = ref.current;
    if (!node) return;
    node.dataset.rail = 'live';
    node.style.setProperty('--rail', progress.toFixed(4));
    const reach = node.getBoundingClientRect().top + node.offsetHeight * progress;
    node.querySelectorAll<HTMLElement>(':scope > li').forEach(item => {
      item.dataset.reached = item.getBoundingClientRect().top + 24 <= reach ? '1' : '0';
    });
  });
  return <ol ref={ref} className={className}>{children}</ol>;
}

/** The floating header slides away while scrolling down and returns on any scroll up (or near the top). */
export function AutoHideHeader({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    // With reduced motion the header simply stays put.
    if (!node || reducedMotion()) return;
    let last = window.scrollY;
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const hide = y > 400 && y > last + 4 && !node.contains(document.activeElement);
      if (hide) node.dataset.hidden = 'true';
      else if (y < last - 4 || y <= 400) delete node.dataset.hidden;
      last = y;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    // Keyboard focus brings the header back, so tabbing never lands on hidden links.
    const onFocus = () => { delete node.dataset.hidden; };
    window.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('focusin', onFocus);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      node.removeEventListener('focusin', onFocus);
    };
  }, []);
  return <header ref={ref} className={className}>{children}</header>;
}

/**
 * A price figure whose digits roll into place the first time it scrolls into view and whenever it changes
 * (monthly ↔ yearly). The accessible name is the plain text.
 */
export function RollNumber({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    if (node.dataset.roll === 'on') return;
    node.dataset.roll = 'ready';
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      requestAnimationFrame(() => { node.dataset.roll = 'on'; });
    }, { rootMargin: '0px 0px -10% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={ref} className={`${styles.roll} ${className ?? ''}`}>
      <span className="sr-only">{value}</span>
      {Array.from(value).map((char, index) => (/\d/.test(char)
        ? (
          <span key={index} className={styles.rollDigit} aria-hidden="true" style={{ '--digit': char } as CSSProperties}>
            <span className={styles.rollStrip}>{'0123456789'.split('').map(d => <span key={d}>{d}</span>)}</span>
          </span>
        )
        : <span key={index} aria-hidden="true">{char}</span>))}
    </span>
  );
}
