/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TriangleAlert } from 'lucide-react';
import { L_SAMPLES_REDO } from '@/lib/landing/landing-copy-l-samples';
import type { SampleData } from '@/lib/landing/sample-reports';
import styles from './samples-l.module.css';

/**
 * Sample L's "10 秒看懂" (Owner 2026-10-17): one card read top to bottom instead of sample J's five-row table. The group
 * and platform on top; the coach's warning first when there is one (「风险提醒」); the one sentence of what to make for
 * whom, large; then three small blocks side by side (stacked on a phone): who you are, how it earns, and this week's
 * first step as an unticked to-do. The data has no separate audience field (it is inside `what`), so the first block
 * is 你是谁.
 */
export function GlanceL({ data, who, platform }: { data: SampleData; who: string; platform: string }) {
  const { glance } = L_SAMPLES_REDO;
  const { summary } = data;
  return (
    <section className={styles.glance} aria-label={glance.title}>
      <p className={styles.glanceWho}><b>{who}</b><span aria-hidden="true"> · </span>{platform}</p>
      {summary.truth ? (
        <div className={styles.risk} role="note">
          <p className={styles.riskLabel}><TriangleAlert size={16} aria-hidden="true" />{glance.risk}</p>
          <p className={styles.riskText}>{summary.truth}</p>
        </div>
      ) : null}
      <p className={styles.glanceWhat}>{summary.what}</p>
      <dl className={styles.glanceBlocks}>
        <div><dt>{glance.who}</dt><dd>{summary.who}</dd></div>
        <div><dt>{glance.money}</dt><dd>{summary.money}</dd></div>
        <div data-todo="true">
          <dt>{glance.first}</dt>
          <dd><span className={styles.box} aria-hidden="true" />{summary.first}</dd>
        </div>
      </dl>
    </section>
  );
}
