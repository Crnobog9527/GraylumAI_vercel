/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronsDown } from 'lucide-react';
import { AsDemo } from '@/components/chat-display/display-heading';
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
/** One step of the wheel or a finger (round nine, V5): this much scrolling, and not sooner than this after the last. */
const STEP_PX = 50;
const STEP_MS = 420;
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
 * Round nine (V5, Owner 2026-10-18: "我老以为我卡在这个页面了，怎么滚都没用"): while the region holds, the wheel (or a
 * finger) always does something, one step per notch: down finishes the scenario being written, or, written, goes on
 * to the next; up goes back to the one before, shown finished. Over the coach's chat it first scrolls the chat, and
 * only at its end moves the scenarios. With the fourth written, the page goes on. (The line under the region saying
 * what the next notch does was taken away, Owner 2026-10-18; the scrolling itself is unchanged.)
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
  const base = useId();
  const startOf = (index: number) => items.slice(0, index).reduce((sum, item) => sum + spanOf(item), 0);

  useEffect(() => { setHeld(!reducedMotion()); setSeen(readSeen()); }, []);
  const at = scenarioAt(items, position);
  // What one step of the wheel does now (V5); read by the listener below, which stays bound.
  const markPlayed = (index: number) => setPlayed(list => {
    if (list.includes(index)) return list;
    const next = [...list, index];
    writePlayed(next);
    return next;
  });
  const steps = useRef({ index: 0, written: false, last: false, finish: () => {}, next: () => {}, prev: () => {} });
  // The scroll only tells whether the region is on screen; the wheel and fingers move it (V5).
  useEffect(() => {
    const node = ref.current;
    if (!held || !node) return;
    let frame = 0;
    let acc = 0;
    let lastStep = 0;
    let touchY = 0;
    const measure = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      setInView(rect.top < window.innerHeight && rect.bottom > 0);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const holding = () => { const rect = node.getBoundingClientRect(); return rect.top <= 4 && rect.bottom >= window.innerHeight - 4; };
    // Over the coach's chat, the chat scrolls first, as long as it can go further that way.
    const chatScrolls = (target: EventTarget | null, delta: number) => {
      const log = target instanceof Element ? target.closest<HTMLElement>('[data-coach-log]') : null;
      if (!log) return false;
      return delta > 0 ? log.scrollTop + log.clientHeight < log.scrollHeight - 1 : log.scrollTop > 0;
    };
    const step = (delta: number, event: Event) => {
      if (!holding() || chatScrolls(event.target, delta)) return;
      const now = steps.current;
      if (delta > 0 && now.last && now.written) return;
      if (delta < 0 && now.index === 0) return;
      event.preventDefault();
      lastScroll.current = Date.now();
      acc += delta;
      if (Math.abs(acc) < STEP_PX || performance.now() - lastStep < STEP_MS) return;
      acc = 0;
      lastStep = performance.now();
      if (delta < 0) now.prev();
      else if (now.written) now.next();
      else now.finish();
    };
    const onWheel = (event: WheelEvent) => step(event.deltaY * (event.deltaMode === 1 ? 16 : 1), event);
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; acc = 0; };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      step(touchY - y, event);
      touchY = y;
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll);
      window.removeEventListener('wheel', onWheel); window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
    };
  }, [held]);
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
  steps.current = {
    index: at.index, written, last: at.index === items.length - 1,
    finish: () => markPlayed(at.index),
    next: () => setPosition(startOf(at.index + 1)),
    prev: () => { markPlayed(at.index - 1); setPosition(startOf(at.index - 1)); },
  };
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
  useEffect(() => { if (playedOut) markPlayed(at.index); }, [playedOut, at.index]);
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
        {/* Owner 2026-10-18: always two lines, "同一个任务，" and then the comparison. */}
        {L_TASKS_TITLE.split(/(?<=，)/).map((part, index) => (
          <Fragment key={part}>{index ? <br /> : null}<span className={compare.phrase}>{part}</span></Fragment>
        ))}
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
          <div className={styles.hands} {...hand}><AsDemo><WorkflowCompareL task={current.task} turns={current.turns} badge={L_SCENARIOS.badge}
            beat={held && !played.includes(active) ? at.beat : Infinity} /></AsDemo></div>
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
