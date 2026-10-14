/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import {
  DEMO_LABEL, DEMO_STEPS, QUESTION_ONE, demoInformation, demoReducer, summaryDemoState, type DemoState,
} from '@/components/landing/demo/demo-script';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { QuestionCardView } from '@/components/opc/question-card';
import { StepConfirmCard } from '@/components/opc/step-confirm-card';
import { Button } from '@/components/ui/button';
import { J_POSITIONING_SAMPLE } from '@/lib/landing/landing-copy-j';
import {
  J_BENCHMARK_KINDS, J_BENCHMARK_TABLE, J_DIRECTION_QUESTION, J_TAKEOVER_SCENES, type TakeoverCard, type TakeoverLine,
} from '@/lib/landing/landing-copy-j-takeover';
import type { QuestionCard } from '@repo/api/src/shared/agentTurn';
import styles from './takeover-j.module.css';

const noop = () => undefined;
const summary = summaryDemoState();
const ready = demoReducer(summary, { type: 'settled' });

/** The checklist's values once a scene is done: 方向判断 adds the direction and its risk, 找对标 the three kinds. */
function stateAt(scene: number): DemoState {
  const captured = (value: string) => ({ value, status: 'confirmed' as const, nature: 'fact' as const });
  const values = { ...summary.values };
  if (scene >= 1) Object.assign(values, { direction: captured(J_POSITIONING_SAMPLE.direction), risk: captured(J_POSITIONING_SAMPLE.reminder) });
  if (scene >= 2) Object.assign(values, { accounts: captured(J_BENCHMARK_KINDS.map(item => item.kind).join('、')) });
  return { ...summary, values };
}

/** How many of a scene's messages have arrived at `local` (0 → 1): the first at once, the last a little before the end. */
export function arrivedAt(local: number, count: number) {
  return Math.min(count, Math.max(1, Math.floor(local * count * 1.15) + 1));
}

/**
 * The real positioning workbench, played by the scroll: the step strip, the conversation (the product's messages,
 * question card, step confirmation) and the checklist on the right filling in. `scene` is 你是谁 / 方向判断 /
 * 找对标; `local` how far into it (0 → 1). The latest messages stay in view at the bottom, like the live chat.
 */
export function PositioningClipJ({ scene, local }: { scene: number; local: number }) {
  const current = J_TAKEOVER_SCENES[scene];
  const lines = current.lines.slice(0, arrivedAt(local, current.lines.length));
  const done = local >= 0.96;
  const valid = Object.fromEntries(DEMO_STEPS.map((step, index) => [step.id, index < scene || (index === scene && done)]));
  const state = stateAt(done ? scene : scene - 1);
  const fetchLocal = Math.max(0, local * 3 - 1.4);
  return (
    <div className={styles.window}>
      <div className={styles.windowBar}><span className={styles.sample}>{DEMO_LABEL}</span><b>我的定位分析</b><span>整体规划 · 进行中</span></div>
      <div className={styles.strip}>
        {DEMO_STEPS.map((step, index) => (
          <Button key={step.id} size="sm" variant={index === scene ? 'default' : 'outline'} tabIndex={-1}>
            {valid[step.id] ? <Check size={14} aria-hidden="true" /> : `${index + 1} `}{step.title}
          </Button>
        ))}
      </div>
      <div className={styles.panes}>
        <div className={styles.log}>
          <div className={styles.logInner}>
            {lines.map((line, index) => <Message key={`${scene}-${index}`} line={line} step={current.title} fetchLocal={fetchLocal} />)}
          </div>
        </div>
        <div className={`${result.panel} ${styles.checklist}`}>
          <header><h2>定位清单</h2><p>跟着对话自动记录；每一步核对后确认一次</p></header>
          <div className={result.body}>
            <CaptureChecklist steps={DEMO_STEPS} information={demoInformation(state)} valid={valid} edits={{}}
              selectedStepId={DEMO_STEPS[scene].id} editable={false} manual={false} locked confirmable={() => false}
              confirmation={() => 'none'} saveState={{}} conflicts={{}} resolving={null} onEdit={noop} onComposition={noop}
              onResolve={noop} onReview={noop} onRecoverConfirmation={noop} onKeepConflict={noop} onRetrySave={noop} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({ line, step, fetchLocal }: { line: TakeoverLine; step: string; fetchLocal: number }) {
  if (line.role === 'user') {
    return (
      <div data-message-role="user" className={styles.user}>
        <span className={result.agentIdentity}>你 · {step}</span>
        <MessageMarkdown className={styles.messageText} text={line.text} />
      </div>
    );
  }
  if (line.role === 'risk') {
    return (
      <div data-message-role="assistant" className={styles.risk}>
        <span className={styles.riskLabel}><AlertTriangle size={14} aria-hidden="true" />风险提示 · {step}</span>
        <p>{line.text}</p>
      </div>
    );
  }
  return (
    <div data-message-role="assistant" className={styles.coach}>
      <span className={result.agentIdentity}>导师 · {step}</span>
      <MessageMarkdown className={styles.messageText} text={line.text} />
      {line.card ? <Card card={line.card} fetchLocal={fetchLocal} /> : null}
    </div>
  );
}

function Card({ card, fetchLocal }: { card: TakeoverCard; fetchLocal: number }) {
  if (card === 'question') return <div className={styles.cardSlot}><QuestionCardView card={QUESTION_ONE} /></div>;
  if (card === 'direction') return <div className={styles.cardSlot}><QuestionCardView card={J_DIRECTION_QUESTION as unknown as QuestionCard} /></div>;
  if (card === 'confirm') {
    return (
      <div className={styles.cardSlot}>
        <StepConfirmCard stepId="you" title={DEMO_STEPS[0].title} info={demoInformation(ready).you} edits={undefined}
          signal={undefined} resuming={false} disabled stays={false} canConfirm={false} onConfirm={noop} onEdit={noop} onReview={noop} />
      </div>
    );
  }
  if (card === 'kinds') {
    return (
      <ul className={styles.kinds}>
        {J_BENCHMARK_KINDS.map(item => <li key={item.kind}><b>{item.kind}</b><span>{item.who}</span><em>{item.learn}</em></li>)}
      </ul>
    );
  }
  if (card === 'fetch') {
    const fetched = Math.min(J_BENCHMARK_KINDS.length, Math.floor(fetchLocal * 4));
    return (
      <ul className={styles.fetch}>
        {J_BENCHMARK_KINDS.map((item, index) => (
          <li key={item.kind} data-done={index < fetched || undefined}>
            {index < fetched ? <Check size={15} aria-hidden="true" /> : <Loader2 size={15} aria-hidden="true" />}
            {item.kind}<span>{index < fetched ? '已取到公开数据' : '正在抓取'}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={styles.tableCard}>
      <p>{J_BENCHMARK_TABLE.title}</p>
      <table>
        <thead><tr>{J_BENCHMARK_TABLE.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {J_BENCHMARK_TABLE.rows.map(row => (
            <tr key={row[0]}>{row.map((cell, index) => (index === 0
              ? <th key={index} scope="row">{cell}</th>
              : <td key={index} data-missing={cell === '未取到' || undefined}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
