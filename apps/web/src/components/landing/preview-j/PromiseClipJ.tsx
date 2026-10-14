/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { CSSProperties } from 'react';
import { ArrowDown, CalendarDays, Check, ListChecks, PackageCheck, TrendingUp } from 'lucide-react';
import { H_COMPARE_SAMPLES } from '@/lib/landing/landing-copy';
import { J_PROMISE_SAMPLES, J_TAKEOVER } from '@/lib/landing/landing-copy-j';
import styles from './takeover-j.module.css';

/**
 * The old promise paragraph as five things you no longer do, one small picture each: the weeks of topics laid out
 * for you, the account basics ticked off by the method, the weekly review written from your data, the route to
 * earning from the sample report, and the models and prompts already packed in. They arrive one after another as
 * the scroll moves on (`progress` 0 → 1); with reduced motion all five are simply there.
 */
export function PromiseClipJ({ progress }: { progress: number }) {
  const lit = (index: number) => progress >= index * 0.17;
  const step = (index: number) => Math.min(1, Math.max(0, (progress - index * 0.17) / 0.15));
  const pictures = [
    <ul key="topics" className={styles.mini}>
      {J_PROMISE_SAMPLES.weeks.map((week, index) => (
        <li key={week} style={{ opacity: step(0) * 3 > index ? 1 : 0.15 } as CSSProperties}><CalendarDays size={15} aria-hidden="true" />{week}</li>
      ))}
    </ul>,
    <ul key="method" className={styles.mini}>
      {J_PROMISE_SAMPLES.basics.map((item, index) => (
        <li key={item} data-done={step(1) * 3 > index || undefined}>
          {step(1) * 3 > index ? <Check size={15} aria-hidden="true" /> : <ListChecks size={15} aria-hidden="true" />}{item}
        </li>
      ))}
    </ul>,
    <dl key="data" className={styles.review}>
      {H_COMPARE_SAMPLES.review.map((item, index) => (
        <div key={item.label} style={{ opacity: step(2) * 3 > index ? 1 : 0.15 } as CSSProperties}>
          <dt><TrendingUp size={14} aria-hidden="true" />{item.label}</dt><dd>{item.text}</dd>
        </div>
      ))}
    </dl>,
    <ol key="money" className={styles.mini}>
      {J_PROMISE_SAMPLES.money.map((item, index) => (
        <li key={item} style={{ opacity: step(3) * 3 > index ? 1 : 0.15 } as CSSProperties}>
          {index > 0 ? <ArrowDown size={14} aria-hidden="true" /> : <TrendingUp size={14} aria-hidden="true" />}{item}
        </li>
      ))}
    </ol>,
    <div key="models" className={styles.packed}>
      <p>{J_PROMISE_SAMPLES.chores.map(chore => <s key={chore} data-done={step(4) > 0.4 || undefined}>{chore}</s>)}</p>
      <p data-done={step(4) > 0.8 || undefined}><PackageCheck size={15} aria-hidden="true" />{J_PROMISE_SAMPLES.packed}</p>
    </div>,
  ];
  return (
    <ol className={styles.promises}>
      {J_TAKEOVER.promises.map((promise, index) => (
        <li key={promise.id} data-lit={lit(index) || undefined}>
          <h4>{promise.title}</h4>
          <p>{promise.line}</p>
          <div className={styles.card}>{pictures[index]}</div>
        </li>
      ))}
    </ol>
  );
}
