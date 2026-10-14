/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useState, type RefObject } from 'react';

/*
 * Plays one scene conversation the way the product shows a reply: the visitor's own lines pop in, the coach first
 * "thinks" (three dots), then types its line, then its card pops in, then the next line. Playback starts when the
 * conversation reaches the screen and restarts when another scene is chosen or `replay` is called.
 *
 * `null` means "show everything": the server HTML, no JavaScript, reduced motion, and the end of playback.
 * The full text of every line is always in the page; playback only decides what is drawn.
 */

export type Playback = { index: number; phase: 'thinking' | 'typing' | 'card' | 'shown'; chars: number } | null;

type Line = { role: 'user' | 'coach'; text: string; card?: unknown };

const THINK_MS = 620;
const TICK_MS = 28;
const CHARS_PER_TICK = 2;
const CARD_MS = 520;
const USER_MS = 650;

/** The next state of a playback, or null once the last line is done. Pure, so it can be tested. */
export function nextPlayback(lines: readonly Line[], state: NonNullable<Playback>): { state: Playback; wait: number } {
  const line = lines[state.index];
  const advance = () => (state.index + 1 < lines.length ? startLine(lines, state.index + 1) : { state: null, wait: 0 });
  if (!line) return { state: null, wait: 0 };
  if (state.phase === 'thinking') return { state: { ...state, phase: 'typing', chars: 0 }, wait: TICK_MS };
  if (state.phase === 'typing') {
    const chars = Math.min(line.text.length, state.chars + CHARS_PER_TICK);
    if (chars < line.text.length) return { state: { ...state, chars }, wait: TICK_MS };
    return line.card ? { state: { ...state, phase: 'card', chars }, wait: CARD_MS } : { state: { ...state, phase: 'shown', chars }, wait: 360 };
  }
  return advance();
}

export function startLine(lines: readonly Line[], index: number): { state: Playback; wait: number } {
  const line = lines[index];
  if (!line) return { state: null, wait: 0 };
  return line.role === 'coach'
    ? { state: { index, phase: 'thinking', chars: 0 }, wait: THINK_MS }
    : { state: { index, phase: 'shown', chars: line.text.length }, wait: USER_MS };
}

export function useScenePlayback(lines: readonly Line[], key: string, target: RefObject<HTMLElement | null>) {
  const [playback, setPlayback] = useState<Playback>(null);
  const [run, setRun] = useState(0);
  const [seen, setSeen] = useState(false);
  const [reduced, setReduced] = useState(false);

  // The visitor can switch reduced motion on while the page is open: playback stops and every line shows.
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener?.('change', sync);
    return () => media.removeEventListener?.('change', sync);
  }, []);

  // Start only once the conversation is on screen; with reduced motion never start. The ref moves to the newly
  // chosen scene's window, so a scene switch before playback started re-observes the new window.
  useEffect(() => {
    const node = target.current;
    if (!node || seen || reduced) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { threshold: 0.3 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, seen, reduced, key]);

  useEffect(() => {
    if (!seen || reduced) {
      setPlayback(null);
      return;
    }
    let timer = 0;
    let step = startLine(lines, 0);
    const tick = () => {
      setPlayback(step.state);
      if (!step.state) return;
      const current = step.state;
      timer = window.setTimeout(() => { step = nextPlayback(lines, current); tick(); }, step.wait);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [seen, reduced, key, run, lines]);

  return { playback, replay: () => setRun(value => value + 1), playing: playback !== null };
}
