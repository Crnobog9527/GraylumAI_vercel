/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { earningCount, earningTotal, L_EARNINGS as E } from '@/lib/landing/landing-copy-l-earnings';
import styles from './earnings-l.module.css';

const ROLL_MS = 600;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** Numbers that roll from the old tier's to the new one's (round seven, T6), frame by frame. */
function useRolled(targets: readonly number[]) {
  const [values, setValues] = useState<readonly number[]>(targets);
  const from = useRef(targets);
  useEffect(() => {
    const start = from.current;
    if (reducedMotion()) { from.current = targets; setValues(targets); return; }
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / ROLL_MS);
      const eased = 1 - (1 - t) ** 3;
      const next = targets.map((target, index) => start[index] + (target - start[index]) * eased);
      from.current = next;
      setValues(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [targets]);
  return values;
}

/** The bar of a count: on a log scale of the first row's, so a handful of people still shows as a sliver. */
const barOf = (count: number, top: number) => Math.max(3, (Math.log10(count + 1) / Math.log10(top + 1)) * 100);

/**
 * "一个月能赚多少？算给你看" under the report's money card: a switch for how many people see the videos a month, and the
 * people left at each step, each with its share in brackets and, in grey, who it is counted from; the month's total
 * at the bottom. The plan's conservative example, marked as one.
 */
export function EarningsL() {
  const [tier, setTier] = useState(0);
  const base = useId();
  const targets = useRef(new Map<number, readonly number[]>());
  if (!targets.current.has(tier)) targets.current.set(tier, [...E.rows.map(row => row.counts[tier]), E.totals[tier]]);
  const rolled = useRolled(targets.current.get(tier)!);
  const top = rolled[0];
  return (
    <section className={styles.earnings} aria-labelledby={`${base}-title`}>
      <h5 id={`${base}-title`}>{E.title}</h5>
      <div className={styles.switch}>
        <span id={`${base}-switch`}>{E.switchLabel}</span>
        <div role="radiogroup" aria-labelledby={`${base}-switch`}>
          {E.tiers.map((label, index) => (
            <button key={label} type="button" role="radio" aria-checked={index === tier} onClick={() => setTier(index)}>{label}</button>
          ))}
        </div>
      </div>
      <ol className={styles.steps}>
        {E.rows.map((row, index) => (
          <li key={row.what}>
            <p className={styles.count}>
              <b>{earningCount(rolled[index])} {row.unit}</b>{row.share ? <span>（{row.share}）</span> : null}
            </p>
            <p className={styles.what}>{row.what}</p>
            <i className={styles.bar} style={{ '--w': `${barOf(rolled[index], top)}%` } as CSSProperties} aria-hidden="true" />
            {row.note ? <small>{row.note}</small> : null}
          </li>
        ))}
      </ol>
      <p className={styles.total}>
        <span>{E.totalLabel}</span><b>{earningTotal(rolled[E.rows.length])}</b>
        {E.yearly[tier] ? <em>{E.yearly[tier]}</em> : null}
      </p>
      <p className={styles.summary}>{E.summary}</p>
      <p className={styles.disclaimer}>{E.disclaimer}</p>
    </section>
  );
}
