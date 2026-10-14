/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { CSSProperties, ReactNode } from 'react';
import { ArrowRight, BarChart3, CircleHelp, Lightbulb, MessageCircleQuestion, NotebookTabs, TrendingUp } from 'lucide-react';
import { DEMO_LABEL, DEMO_STEPS, demoInformation, demoReducer, summaryDemoState } from '@/components/landing/demo/demo-script';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { StepConfirmCard } from '@/components/opc/step-confirm-card';
import { H_COMPARE, H_COMPARE_SAMPLES } from '@/lib/landing/landing-copy';
import { cn } from '@/lib/utils';
import styles from './compare-h.module.css';
import hero from './hero-h.module.css';

const noop = () => undefined;
// The demo case at its summary (every field filled, not yet confirmed) and once confirmed.
const ready = demoReducer(summaryDemoState(), { type: 'settled' });
const confirmed = demoReducer(ready, { type: 'confirm' });

/**
 * "自己用通用 AI ／ 用 Graylum AI 教练" (the Owner's wording) as pictures, not a table: each row puts a small
 * scene of the mess on the left against the product piece that fixes it on the right — the positioning checklist,
 * the step confirmation, the library's memory and the weekly review — all from the demo's made-up case (示例).
 * On a phone each row stacks, the mess above the fix. The pictures are decorative; the row text carries the meaning.
 */
export function CompareH() {
  const scenes = [<Questions key="q" />, <Pile key="p" />, <Windows key="w" />, <Unread key="u" />];
  const fixes = [<Checklist key="c" />, <Confirm key="s" />, <Library key="l" />, <Review key="r" />];
  return (
    <div className={styles.compare}>
      <h3 id="compare-title" className={styles.title}>{H_COMPARE.title}</h3>
      <div className={styles.head} aria-hidden="true">
        <span>{H_COMPARE.generic}</span><span>{H_COMPARE.coach}</span>
      </div>
      <ol className={styles.rows}>
        {H_COMPARE.rows.map((row, index) => (
          <li key={row.coach} className={styles.row}>
            <div className={styles.mess}>
              <p><span className={styles.who}>{H_COMPARE.generic}</span>{row.generic}</p>
              <div className={styles.scene} aria-hidden="true">{scenes[index]}</div>
            </div>
            <span className={styles.to} aria-hidden="true"><ArrowRight size={18} /></span>
            <div className={styles.fix}>
              <p><span className={styles.who}>{H_COMPARE.coach}</span>{row.coach}</p>
              <div className={cn(styles.piece, hero.drift)} style={{ '--drift': `${10 + (index % 2) * 10}px` } as CSSProperties}
                aria-hidden="true">
                <span className={styles.sample}>{DEMO_LABEL}</span>
                {fixes[index]}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* The mess: drawn with icons only, no made-up text */
function Questions() {
  const spots = [[8, 18, -14, 26], [38, 4, 10, 18], [62, 30, -6, 22], [24, 58, 16, 20], [72, 62, -18, 28], [48, 70, 4, 16]];
  return <>{spots.map(([x, y, r, size]) => (
    <MessageCircleQuestion key={`${x}-${y}`} className={styles.scattered} size={size} strokeWidth={1.6}
      style={{ left: `${x}%`, top: `${y}%`, rotate: `${r}deg` }} />
  ))}</>;
}
function Pile() {
  return <>{[-14, -6, 3, 11, 19].map((r, index) => (
    <span key={r} className={styles.pileCard} style={{ rotate: `${r}deg`, translate: `${index * 10 - 20}px ${index * 3}px` }}>
      <Lightbulb size={15} strokeWidth={1.8} />
    </span>
  ))}</>;
}
function Windows() {
  return <>{[0, 1, 2].map(index => (
    <span key={index} className={styles.window} style={{ translate: `${index * 18 - 18}px ${index * 14 - 14}px` }}>
      <i /><i /><i /><b>新对话</b>
    </span>
  ))}</>;
}
function Unread() {
  return (
    <span className={styles.unread}>
      <BarChart3 size={40} strokeWidth={1.4} />
      <CircleHelp className={styles.unreadMark} size={20} strokeWidth={1.8} />
    </span>
  );
}

/* The fix: the product's own pieces */
function Checklist() {
  return (
    <div className={cn(result.panel, styles.checklist)}>
      <CaptureChecklist steps={DEMO_STEPS.slice(0, 1)} information={demoInformation(confirmed)} valid={{ you: true }}
        edits={{}} selectedStepId="you" editable={false} manual={false} locked confirmable={() => false}
        confirmation={() => 'none'} saveState={{}} conflicts={{}} resolving={null} onEdit={noop} onComposition={noop}
        onResolve={noop} onReview={noop} onRecoverConfirmation={noop} onKeepConflict={noop} onRetrySave={noop} />
    </div>
  );
}
function Confirm() {
  return (
    <StepConfirmCard stepId="you" title={DEMO_STEPS[0].title} info={demoInformation(ready).you} edits={undefined}
      signal={undefined} resuming={false} disabled stays={false} canConfirm={false} onConfirm={noop} onEdit={noop} onReview={noop} />
  );
}
function Library() {
  return (
    <Card icon={<NotebookTabs size={16} strokeWidth={1.8} />} title="资料库">
      {H_COMPARE_SAMPLES.library.map(item => <p key={item.label}><b>{item.label}</b>{item.text}</p>)}
    </Card>
  );
}
function Review() {
  return (
    <Card icon={<TrendingUp size={16} strokeWidth={1.8} />} title="每周复盘">
      {H_COMPARE_SAMPLES.review.map(item => <p key={item.label}><b>{item.label}</b>{item.text}</p>)}
    </Card>
  );
}
function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>{icon}{title}</p>
      {children}
    </div>
  );
}
