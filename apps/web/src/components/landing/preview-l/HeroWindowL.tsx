/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { AsDemo } from '@/components/chat-display/display-heading';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { J_FIELD_VALUES, J_FIELDS, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_BENCHMARK_TABLE } from '@/lib/landing/landing-copy-j-takeover';
import { L_LATER_FLYWHEEL } from '@/lib/landing/landing-copy-l-later';
import { L_PLAIN_SWAPS } from '@/lib/landing/landing-copy-l-positioning';
import { DemoTag } from './DemoTag';
import { STEP_ONE_PICTURES } from './StepOneFlowL';
import styles from './dawn-l.module.css';

const [FIRST_REVIEW] = L_LATER_FLYWHEEL.review.rows;
/** The stage the window shows: step one's third, 定位与执行方案 (STEP_ONE_PICTURES is keyed by the stage's place). */
const SHOWN = 2;

const FIELD_TITLES = new Map(Object.values(J_FIELDS).flat().map(field => [field.id, field.title]));
/** The coach in plain words, as the page's own conversation says it (round thirteen's swaps, landing-copy-l-positioning.ts). */
const plain = (text: string) => L_PLAIN_SWAPS.reduce((line, [from, to]) => line.split(from).join(to), text);
/**
 * One of the coach's judgements for this person, as the product's checklist holds it: the field's name and the value
 * the coach proposed (J_FIELD_VALUES, "草稿 · AI 教练建议" in the product). Only fields from steps one and two: step
 * three's are already in the window's own confirm area.
 */
export const HERO_JUDGEMENTS = {
  left: ['goal', 'benchmark_findings'],
  right: ['feasibility', 'platform_choice'],
} as const;
/**
 * The benchmark card's title. The table's own title ends in （示例）; the card carries the 示例 tag beside its title like the
 * other five, so the word is said once (staging review of #1929).
 */
export const HERO_BENCHMARK_TITLE = J_BENCHMARK_TABLE.title.replace(`（${DEMO_LABEL}）`, '');
export const heroJudgement = (id: string) => ({ title: FIELD_TITLES.get(id) ?? '', value: plain(J_FIELD_VALUES[id]?.value ?? '') });

function Judgement({ id }: { id: string }) {
  const { title, value } = heroJudgement(id);
  return <div className={styles.card}><h3>{title}<DemoTag /></h3><p>{value}</p></div>;
}

/**
 * The first screen's product window (Owner 2026-11-11: "保留窗口", in place of 2026-10-17's text-only first screen).
 * Inside it is step one's third picture as region 3 draws it, finished and still: the one-sentence position in the
 * product's own coach message, the person agreeing, the step's summary and its confirm area (StepOneFlowL), so nothing
 * of the product is drawn a second time here. That picture carries no element ids, so showing it twice on one page
 * (here and in region 3) repeats none; the first picture's checklist has ids and would. It is an example, marked so,
 * inert, and its headings are plain elements.
 *
 * Beside it on a very wide screen, three small cards on each side (Owner 2026-11-12: "只放两个还不够，可以多放几个……
 * 定位过程中间会涉及到的 AI 教练判断小卡片"): the coach's judgements along the way for the same person, in the words
 * the product and this page already use (the checklist's field names and proposed values, the benchmark table's rows,
 * the week's review). They are decoration, out of the reading order, and sit clear of the conversation. Each carries the
 * window's own 示例 tag: read alone, a card ("一年后希望每月多几百美元") must not pass for something we promise.
 */
export function HeroWindowL() {
  const [goal, findings] = HERO_JUDGEMENTS.left;
  const [feasibility, platform] = HERO_JUDGEMENTS.right;
  return (
    <div className={styles.stage} data-region="首屏产品窗口">
      <div className={styles.side} data-side="left" aria-hidden="true">
        <Judgement id={goal} />
        <div className={styles.card}>
          <h3>{HERO_BENCHMARK_TITLE}<DemoTag /></h3>
          <ul>{J_BENCHMARK_TABLE.rows.slice(0, 3).map(([account, state]) => <li key={account}>{account}<span>{state}</span></li>)}</ul>
        </div>
        <Judgement id={findings} />
      </div>
      <div className={styles.side} data-side="right" aria-hidden="true">
        <Judgement id={feasibility} />
        <Judgement id={platform} />
        <div className={styles.card}>
          <h3>{L_LATER_FLYWHEEL.review.notice}<DemoTag /></h3>
          <p>{FIRST_REVIEW[0]}</p>
          <strong>{FIRST_REVIEW[1]}</strong>
          <em>{FIRST_REVIEW[2]}</em>
        </div>
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
