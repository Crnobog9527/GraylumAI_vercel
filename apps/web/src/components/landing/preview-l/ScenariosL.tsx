/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronsDown } from 'lucide-react';
import compare from '@/components/landing/preview-j/compare-j.module.css';
import page from '@/components/landing/preview-j/j.module.css';
import { L_TASKS, L_TASKS_TITLE } from '@/lib/landing/landing-copy-l-compare';
import { L_SCENARIOS, L_STEPS } from '@/lib/landing/landing-copy-l-steps';
import { L_WORKFLOWS } from '@/lib/landing/landing-copy-l-workflows';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import styles from './scenarios-l.module.css';
import { useTypingGate } from './typing-l';
import { CountdownBar, countdownHost, useAutoAdvance } from './use-auto-advance';
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
const PLAYED_KEY = 'graylum-landing-l-scenarios-played';
const readPlayed = (): number[] => { try { return JSON.parse(window.localStorage.getItem(PLAYED_KEY) ?? '[]'); } catch { return []; } };
const writePlayed = (ids: readonly number[]) => { try { window.localStorage.setItem(PLAYED_KEY, JSON.stringify(ids)); } catch { /* not remembered */ } };

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
 * - Left alone, it plays on by itself. Scrolling the page down never moves it back; scrolling up does. A tab jumps to
 *   its scenario.
 * - The coach's chat shows its scrollbar and can be scrolled by the visitor (it stops following the newest line until
 *   the next scenario).
 * Round eight (U8, Owner 2026-10-18): no pause, by the pointer or a button; each scenario plays once and, played, is
 * remembered in this browser and shown finished when it comes back. U9: the typing never stops, but the page moves on
 * to the next scenario by itself only when this one is written, has been on screen 8 seconds since, and the pointer has
 * been out of the chat windows for a second (a finger in them holds it 8 seconds); a thin bar on the next tab fills for
 * 3 seconds first and empties when the pointer comes back. A tab clicked stays until the same holds.
 * Server HTML, no JavaScript and reduced motion: one scenario at a time with the tabs, each conversation whole.
 */
export function ScenariosL({ flags, after }: { flags: LandingFlags; after?: ReactNode }) {
  const items: Item[] = L_TASKS.map((task, index) => ({ task, copy: L_SCENARIOS.items[index], turns: L_WORKFLOWS[index] ?? [] }))
    .filter(item => item.copy && allOn(flags, item.task.needs));
  const total = items.reduce((sum, item) => sum + spanOf(item), 0);
  const [held, setHeld] = useState(false);
  const [position, setPosition] = useState(0);
  const [played, setPlayed] = useState<readonly number[]>([]);
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
  const startOf = (index: number) => items.slice(0, index).reduce((sum, item) => sum + spanOf(item), 0);

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
  const at = scenarioAt(items, position);
  const playBeats = items[at.index] ? workflowBeats(items[at.index].turns) : 0;
  const written = played.includes(at.index) || (at.beat >= playBeats && !busy);
  // Left alone and on screen, a scenario plays on by itself to its end (not while the page is being scrolled).
  const playing = held && inView && !busy && !played.includes(at.index) && at.beat < playBeats;
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
  const lastWritten = held && written && at.index === items.length - 1;
  useEffect(() => { if (lastWritten) writeSeen(); }, [lastWritten]);
  // Written, it moves on to the next scenario by the shared rules (U9, use-auto-advance.tsx).
  const { countdown, hand } = useAutoAdvance({
    on: held && inView, written, hasNext: at.index < items.length - 1, part: at.index,
    next: () => setPosition(startOf(at.index + 1)),
  });

  const active = held ? at.index : staticActive;
  // A scenario played to its end is remembered (round eight, U8): from then on it shows finished.
  const playedOut = held && items[at.index] ? at.beat >= workflowBeats(items[at.index].turns) : false;
  useEffect(() => { setPlayed(readPlayed()); }, []);
  useEffect(() => {
    if (!playedOut || played.includes(at.index)) return;
    const next = [...played, at.index];
    setPlayed(next);
    writePlayed(next);
  }, [playedOut, played, at.index]);
  // On a phone the tabs share a row with the controls and scroll sideways: the current one is kept in view.
  useEffect(() => {
    const row = tabs.current;
    const tab = row?.children[active] as HTMLElement | undefined;
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = Math.max(0, Math.min(tab.offsetLeft - row.offsetLeft - 16, row.scrollWidth - row.clientWidth));
  }, [active]);

  if (!items.length) return null;
  const current = items[active];
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
                className={countdownHost}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => pick(index)}>
                {item.copy.tab}
                {held && index === at.index + 1 ? <CountdownBar share={countdown} /> : null}
              </button>
            ))}
          </div>
          {held ? (
            <div className={styles.controls}>
              {seen ? (
                <button type="button" className={styles.pause} onClick={skip} aria-label={L_STEPS.skip}>
                  <ChevronsDown size={14} aria-hidden="true" /><span className={styles.label}>{L_STEPS.skip}</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div role={items.length > 1 ? 'tabpanel' : undefined} id={`${base}-panel`}
        aria-labelledby={items.length > 1 ? `${base}-tab-${active}` : undefined} className={styles.panel} key={current.copy.tab}>
        <h3 className={styles.title}>{current.copy.title}</h3>
        <p className={styles.lede}>{current.copy.lede}</p>
        <TypingScope>
          <div className={styles.hands} {...hand}><WorkflowCompareL task={current.task} turns={current.turns} badge={L_SCENARIOS.badge}
            beat={held && !played.includes(active) ? at.beat : Infinity} /></div>
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
