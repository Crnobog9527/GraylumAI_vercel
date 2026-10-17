/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronsDown, Pause, Play } from 'lucide-react';
import compare from '@/components/landing/preview-j/compare-j.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { L_TASKS, L_TASKS_TITLE } from '@/lib/landing/landing-copy-l-compare';
import { L_SCENARIOS, L_STEPS } from '@/lib/landing/landing-copy-l-steps';
import { L_WORKFLOWS } from '@/lib/landing/landing-copy-l-workflows';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import styles from './scenarios-l.module.css';
import { useTypingGate } from './typing-l';
import { WorkflowCompareL, workflowBeats } from './WorkflowCompareL';

/** How long one beat of the coach's work lasts when it plays by itself (milliseconds). */
const BEAT_MS = 1100;
/** Beats a whole conversation stays before the next scenario. */
const HOLD_BEATS = 3;
/** After the visitor scrolls the page, the play waits this long before going on by itself. */
const SCROLL_QUIET_MS = 1500;
const SEEN_KEY = 'graylum-landing-l-scenarios-seen';
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const readSeen = () => { try { return window.localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };
const writeSeen = () => { try { window.localStorage.setItem(SEEN_KEY, '1'); } catch { /* private window: not remembered */ } };

type Item = { task: (typeof L_TASKS)[number]; copy: (typeof L_SCENARIOS.items)[number]; turns: (typeof L_WORKFLOWS)[number] };
const spanOf = (item: Item) => workflowBeats(item.turns) + HOLD_BEATS;

/** Where a position (in beats over all scenarios) falls: which scenario, and how far into it. */
export function scenarioAt(items: readonly Item[], position: number) {
  let from = 0;
  for (const [index, item] of items.entries()) {
    if (position < from + spanOf(item) || index === items.length - 1) return { index, beat: Math.max(0, position - from) };
    from += spanOf(item);
  }
  return { index: 0, beat: 0 };
}

/**
 * Region 6 (Owner 2026-10-17): one scenario at a time, the general AI's usual answer beside the coach's whole work
 * conversation (WorkflowCompareL). Round six (S14):
 * - The region holds on screen while the page scrolls through it; the scroll plays the four scenarios in order, beat by
 *   beat, so they are all seen before the page goes on. A visitor who has seen them before (remembered in this browser)
 *   gets a button that jumps past.
 * - Left alone, it plays on by itself; the visitor's hand on the coach's chat (pointer over it, scrolling it, a click) or
 *   the pause button stops it, and it goes on when the hand leaves. Scrolling the page down never moves it back;
 *   scrolling up does. A tab jumps to its scenario.
 * - The coach's chat can be scrolled by the visitor (it stops following the newest line until the next scenario).
 * Server HTML, no JavaScript and reduced motion: one scenario at a time with the tabs, each conversation whole.
 */
export function ScenariosL({ flags, after }: { flags: LandingFlags; after?: ReactNode }) {
  const items: Item[] = L_TASKS.map((task, index) => ({ task, copy: L_SCENARIOS.items[index], turns: L_WORKFLOWS[index] ?? [] }))
    .filter(item => item.copy && allOn(flags, item.task.needs));
  const total = items.reduce((sum, item) => sum + spanOf(item), 0);
  const [held, setHeld] = useState(false);
  const [position, setPosition] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [holding, setHolding] = useState(false);
  const [inView, setInView] = useState(false);
  const [seen, setSeen] = useState(false);
  const [staticActive, setStaticActive] = useState(0);
  // What the coach is typing holds the next beat (round seven, T8).
  const { Provider: TypingScope, busy } = useTypingGate();
  const ref = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);
  const lastProgress = useRef(0);
  const base = useId();

  useEffect(() => { setHeld(!reducedMotion()); setSeen(readSeen()); }, []);
  // The page's scroll through the region sets the position: down never moves it back, up does.
  useEffect(() => {
    const node = ref.current;
    if (!held || !node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      setInView(rect.top < window.innerHeight && rect.bottom > 0);
      const progress = Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height - window.innerHeight)));
      const down = progress >= lastProgress.current;
      if (progress !== lastProgress.current) lastScroll.current = Date.now();
      lastProgress.current = progress;
      const scrolled = Math.floor(progress * total);
      setPosition(current => (down ? Math.max(current, scrolled) : scrolled));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
  }, [held, total]);
  // Left alone and on screen, it plays on by itself (not while the page is being scrolled).
  const playing = held && inView && !stopped && !holding && !busy && position < total;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (Date.now() - lastScroll.current < SCROLL_QUIET_MS) setTick(value => value + 1);
      else setPosition(value => Math.min(total, value + 1));
    }, BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [playing, position, total, tick]);
  // All of them seen: remembered, so a later visit may skip.
  useEffect(() => { if (held && position >= total - HOLD_BEATS) writeSeen(); }, [held, position, total]);

  const at = scenarioAt(items, position);
  const active = held ? at.index : staticActive;
  // On a phone the tabs share a row with the controls and scroll sideways: the current one is kept in view.
  useEffect(() => {
    const row = tabs.current;
    const tab = row?.children[active] as HTMLElement | undefined;
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = Math.max(0, Math.min(tab.offsetLeft - row.offsetLeft - 16, row.scrollWidth - row.clientWidth));
  }, [active]);

  if (!items.length) return null;
  const current = items[active];
  const startOf = (index: number) => items.slice(0, index).reduce((sum, item) => sum + spanOf(item), 0);
  const pick = (index: number) => (held ? setPosition(startOf(index)) : setStaticActive(index));
  const skip = () => {
    const node = ref.current;
    if (node) window.scrollTo({ top: window.scrollY + node.getBoundingClientRect().bottom - 80, behavior: 'auto' });
  };

  const stage = (
    <div className={cn(page.wrap, held && styles.fill)}>
      <h2 id="compare-title" className={cn(compare.title, held && styles.heldTitle)}>
        {L_TASKS_TITLE.split(/(?<=，)/).map(part => <span key={part} className={compare.phrase}>{part}</span>)}
      </h2>
      {items.length > 1 ? (
        <div className={styles.bar}>
          <div ref={tabs} role="tablist" aria-label={L_SCENARIOS.label} className={styles.tabs}>
            {items.map((item, index) => (
              <button key={item.copy.tab} type="button" role="tab" id={`${base}-tab-${index}`} aria-controls={`${base}-panel`}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => pick(index)}>{item.copy.tab}</button>
            ))}
          </div>
          {held ? (
            <div className={styles.controls}>
              {seen ? (
                <button type="button" className={styles.pause} onClick={skip} aria-label={L_STEPS.skip}>
                  <ChevronsDown size={14} aria-hidden="true" /><span className={styles.label}>{L_STEPS.skip}</span>
                </button>
              ) : null}
              <button type="button" className={styles.pause} onClick={() => setStopped(value => !value)}
                aria-label={stopped ? L_SCENARIOS.play : L_SCENARIOS.pause}>
                {stopped ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                <span className={styles.label}>{stopped ? L_SCENARIOS.play : L_SCENARIOS.pause}</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div role={items.length > 1 ? 'tabpanel' : undefined} id={`${base}-panel`}
        aria-labelledby={items.length > 1 ? `${base}-tab-${active}` : undefined} className={styles.panel} key={current.copy.tab}>
        <h3 className={styles.title}>{current.copy.title}</h3>
        <p className={styles.lede}>{current.copy.lede}</p>
        <TypingScope>
          <WorkflowCompareL task={current.task} turns={current.turns} beat={held ? at.beat : Infinity} badge={L_SCENARIOS.badge}
            onHold={setHolding} />
        </TypingScope>
      </div>
    </div>
  );

  return (
    <section aria-labelledby="compare-title" className={cn(page.section, held && styles.held)} data-zone="compare"
      data-band="ink" data-region="对比区">
      {/* Round seven (T10): the held stage has its own track, so what follows (the call to action) comes after it
          instead of scrolling across the held picture. */}
      {held ? <div ref={ref} className={styles.track}><div className={styles.stage}>{stage}</div></div> : stage}
      {after ? <div className={cn(page.wrap, held && styles.after)}>{after}</div> : null}
    </section>
  );
}
