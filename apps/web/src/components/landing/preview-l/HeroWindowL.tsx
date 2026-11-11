/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { AsDemo } from '@/components/chat-display/display-heading';
import { J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_BENCHMARK_TABLE } from '@/lib/landing/landing-copy-j-takeover';
import { L_LATER_FLYWHEEL } from '@/lib/landing/landing-copy-l-later';
import { cn } from '@/lib/utils';
import { DemoTag } from './DemoTag';
import { STEP_ONE_PICTURES } from './StepOneFlowL';
import styles from './dawn-l.module.css';

const [FIRST_REVIEW] = L_LATER_FLYWHEEL.review.rows;
/** The stage the window shows: step one's third, 定位与执行方案 (STEP_ONE_PICTURES is keyed by the stage's place). */
const SHOWN = 2;

/**
 * The first screen's product window (Owner 2026-11-11: "保留窗口", in place of 2026-10-17's text-only first screen).
 * Inside it is step one's third picture as region 3 draws it, finished and still: the one-sentence position in the
 * product's own coach message, the person agreeing, the step's summary and its confirm area (StepOneFlowL), so nothing
 * of the product is drawn a second time here. That picture carries no element ids, so showing it twice on one page
 * (here and in region 3) repeats none; the first picture's checklist has ids and would. It is an example, marked so,
 * inert, and its headings are plain elements. The two cards beside it on a very wide screen repeat lines the page
 * already carries (the benchmark table's rows, the week's review) and are decoration.
 */
export function HeroWindowL() {
  return (
    <div className={styles.stage} data-region="首屏产品窗口">
      <div className={cn(styles.card, styles.found)} aria-hidden="true">
        <h3>{J_BENCHMARK_TABLE.title}</h3>
        <ul>{J_BENCHMARK_TABLE.rows.slice(0, 3).map(([account, state]) => <li key={account}>{account}<span>{state}</span></li>)}</ul>
      </div>
      <div className={cn(styles.card, styles.review)} aria-hidden="true">
        <h3>{L_LATER_FLYWHEEL.review.notice}</h3>
        <p>{FIRST_REVIEW[0]}</p>
        <strong>{FIRST_REVIEW[1]}</strong>
        <em>{FIRST_REVIEW[2]}</em>
      </div>
      <div className={styles.window}>
        <div className={styles.bar}>
          <ol className={styles.stages}>
            {J_STEPS.map((step, index) => (
              <li key={step.id} data-on={index === SHOWN || undefined}><span aria-hidden="true">{index + 1}</span>{step.title}</li>
            ))}
          </ol>
          <DemoTag />
        </div>
        <div className={styles.screen} inert><AsDemo>{STEP_ONE_PICTURES[SHOWN].draw(null)}</AsDemo></div>
      </div>
    </div>
  );
}
