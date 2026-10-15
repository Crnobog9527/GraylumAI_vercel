/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Check, Compass, Lightbulb, PenLine, Send, type LucideIcon } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import result from '@/components/opc/positioning-result.module.css';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { J_WEEK, type WeekCard, type WeekLine } from '@/lib/landing/landing-copy-j-week';
import { ConfirmJ, personaInformation } from './WorkbenchPartsJ';
import { useOwnerEditing } from './use-owner-editing';
import styles from './week-j.module.css';

const STAGE_ICONS: readonly LucideIcon[] = [Compass, Lightbulb, PenLine, Send, BarChart3];
const LINES = J_WEEK.lines;
const LAST_STAGE = J_WEEK.stages.length - 1;
/** Where the server HTML and reduced motion rest: the review, finished. */
const REST = LINES.findIndex(line => line.stage === LAST_STAGE);

/** How long a message stays the newest before the next one arrives: long enough to read it; cards get extra time. */
export function lineMs(line: WeekLine) {
  return 1200 + Array.from(line.text).length * 30 + (line.card ? 1500 : 0);
}
/** One loop of the week, in milliseconds (the Owner asked for roughly 40–60 seconds). */
export const WEEK_LOOP_MS = LINES.reduce((sum, line) => sum + lineMs(line), 0);
const HOLD_MS = 4000;
/** After a visitor picks a module, how long the window rests at its end before the loop carries on. */
export const CLICK_HOLD_MS = 12000;
const OPENING = 4;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * The first screen's product window (Owner 2026-10-15, round two): one week with the AI coach as one conversation,
 * message by message, the coach driving each stage — it asks, proposes, waits for a yes, then moves on. The five stage
 * labels light with the stage of the newest message, and each is a button: it plays that module from its start (Owner
 * 2026-10-15, round six). It loops while on screen. The server HTML and reduced motion show the review stage, finished.
 */
export function WeekJ() {
  // -1: at rest. 0 and up: how many messages have arrived (the newest is count - 1).
  const [count, setCount] = useState(-1);
  const [playing, setPlaying] = useState(false);
  // The module a visitor picked: it plays from its start; at its end the window rests, then the loop carries on.
  const [focus, setFocus] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const editing = useOwnerEditing();

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setPlaying(entries.some(entry => entry.isIntersecting)));
    observer.observe(node);
    // Open with the first two exchanges already there, so the window never starts out empty; play on from the next.
    setCount(OPENING);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || editing || count < 0) return;
    const done = count >= LINES.length;
    const leaving = focus !== null && (done || LINES[count].stage !== focus);
    const wait = leaving ? CLICK_HOLD_MS : done ? HOLD_MS : lineMs(LINES[count - 1]);
    const timer = window.setTimeout(() => {
      if (leaving) setFocus(null);
      setCount(done ? OPENING : count + 1);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [playing, editing, count, focus]);

  /** Play one module from its first message (the current one too: it starts again). Reduced motion: show it finished. */
  const pick = (index: number) => {
    const first = LINES.findIndex(line => line.stage === index);
    const last = first + LINES.filter(line => line.stage === index).length - 1;
    setFocus(index);
    setCount(reducedMotion() ? last + 1 : first + 1);
  };

  // Once the conversation is longer than the window, keep the newest messages and drop whole older ones from the top,
  // so the window always starts on the top of a message (never half a line) and the newest one stays in view.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const fit = () => fitNewest(log);
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [count]);

  const shown = count < 0 ? LINES.slice(REST) : LINES.slice(0, count);
  const stage = shown[shown.length - 1]?.stage ?? 0;
  const firstOfStage = shown.findIndex(line => line.stage === stage);
  return (
    <figure ref={ref} className={styles.stage} aria-label={J_WEEK.label} data-stage={stage}>
      <ol className={styles.stages} aria-label={J_WEEK.pickLabel}>
        {J_WEEK.stages.map((name, index) => {
          const Icon = STAGE_ICONS[index];
          return (
            <li key={name} data-on={index === stage || undefined} data-done={index < stage || undefined}>
              <button type="button" aria-current={index === stage ? 'step' : undefined} onClick={() => pick(index)}>
                <Icon size={15} strokeWidth={1.9} aria-hidden="true" />{name}
              </button>
            </li>
          );
        })}
      </ol>
      <div className={styles.window} inert aria-hidden="true">
        <div className={styles.chrome}>
          <span className={styles.dots}><i /><i /><i /></span>
          <span className={styles.badge}>{DEMO_LABEL}</span>
          <span className={styles.chromeTitle}>{J_WEEK.title}</span>
          <span className={styles.chromeStage}>{J_WEEK.stages[stage]}</span>
        </div>
        <div className={styles.body}>
          <div ref={logRef} className={styles.log}>
            {shown.map((line, index) => (
              <Message key={`${index}-${line.text}`} line={line} divider={index === firstOfStage && index > 0 ? J_WEEK.stages[line.stage] : null}
                live={count >= 0 && index === shown.length - 1} />
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

/** Hide the oldest messages that do not fit whole above the newest ones; the window then shows from a message's top. */
function fitNewest(log: HTMLElement) {
  const items = Array.from(log.children) as HTMLElement[];
  for (const item of items) item.style.display = '';
  const style = getComputedStyle(log);
  const room = log.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const gap = parseFloat(style.rowGap) || 0;
  let used = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    used += items[index].offsetHeight + (index < items.length - 1 ? gap : 0);
    if (used > room && index < items.length - 1) {
      for (const item of items.slice(0, index + 1)) item.style.display = 'none';
      return;
    }
  }
}

function Message({ line, divider, live }: { line: WeekLine; divider: string | null; live: boolean }) {
  return (
    <>
      {divider ? <p className={styles.divider}><span>{divider}</span></p> : null}
      {line.role === 'user'
        ? <p className={styles.user} data-live={live || undefined}>{line.text}</p>
        : (
          <div className={styles.coach} data-live={live || undefined}>
            <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" />AI 自媒体陪跑教练{line.stage === 0 ? ' · 了解你' : ''}</span>
            <p>{line.text}</p>
            {line.card ? <Card card={line.card} /> : null}
          </div>
        )}
    </>
  );
}

/** 上升 / 下降 / 持平, for the colour of a review cell. */
const trendOf = (cell: string) => (cell.startsWith('下降') ? 'down' : cell.includes('上升') ? 'up' : 'flat');

function Card({ card }: { card: WeekCard }) {
  const cards: Record<WeekCard, ReactNode> = {
    confirm: <div className={styles.confirm}><ConfirmJ step="了解你" information={personaInformation(new Set(['goal', 'audience', 'resource']), 0)} /></div>,
    topics: (
      <ol className={styles.topics}>
        {J_WEEK.topics.items.map(item => <li key={item.title}><b>{item.title}</b><span>{item.why}</span></li>)}
      </ol>
    ),
    draft: (
      <div className={styles.doc}>
        <p className={styles.docTitle}>{J_WEEK.draft.title}</p>
        {J_WEEK.draft.lines.map(text => <p key={text}>{text}</p>)}
      </div>
    ),
    publish: (
      <div className={styles.publish}>
        <ul>{J_WEEK.publish.platforms.map(platform => <li key={platform.name}><Checkbox checked={platform.on} tabIndex={-1} />{platform.name}</li>)}</ul>
        <Button size="sm" tabIndex={-1}>{J_WEEK.publish.action}</Button>
      </div>
    ),
    fetch: (
      <ul className={styles.fetch}>{J_WEEK.fetch.map(text => <li key={text}><Check size={14} aria-hidden="true" />{text}</li>)}</ul>
    ),
    trend: (
      <div className={styles.trend}>
        <span>{J_WEEK.trend}</span>
        <svg viewBox="0 0 200 50" preserveAspectRatio="none" aria-hidden="true">
          <path className={styles.trendFill} d="M0 40 C 30 40 60 41 90 39 S 140 22 200 8 L 200 50 L 0 50 Z" />
          <path className={styles.trendLine} d="M0 40 C 30 40 60 41 90 39 S 140 22 200 8" />
        </svg>
      </div>
    ),
    platforms: (
      <table className={styles.table}>
        <thead><tr>{J_WEEK.platforms.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {J_WEEK.platforms.rows.map(row => (
            <tr key={row[0]}>{row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th>
              : <td key={index} data-trend={index === 2 ? trendOf(cell) : undefined}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    ),
  };
  return cards[card];
}
