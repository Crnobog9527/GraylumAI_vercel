/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { ReactNode } from 'react';
import { MentorReply, MentorUserMessage } from '@/components/chat-display/mentor-messages';
import { ConfirmJ, filledUpTo, personaInformation } from '@/components/landing/preview-j/WorkbenchPartsJ';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { Button } from '@/components/ui/button';
import { J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT } from '@/lib/landing/landing-copy-j-takeover';
import { L_FLOW_ONE as COPY } from '@/lib/landing/landing-copy-l-flow';
import { cuesAt, loopMs, typedAt, typeMs, LOOP_USER_CPS, type CueList } from '@/lib/landing/loop-timeline';
import { Arrive, Feed, type FlowPicture } from './FlowModuleL';
import { BenchmarkL, ReportOverviewL, ResearchCallsL } from './RealPartsL';
import styles from './flow-l.module.css';
import { TypingFrame } from './typing-l';

const noop = () => undefined;
const [KNOW, , PLAN] = J_STEPS;
const label = (step: { title: string }) => ` · ${step.title}`;

/** The coach's message being written, on the product's own bubble. */
function Coach({ step, text, whole, kind = 'reply' }: { step: { title: string }; text: string; whole: boolean; kind?: 'reply' | 'summary' }) {
  return <TypingFrame typing={!whole}><MentorReply kind={kind} stepLabel={label(step)} text={text} live={!whole} /></TypingFrame>;
}

/* 了解你: one question, the person's answer, and the checklist writing it down. */
const KNOW_CUES = [
  ['ask', typeMs(COPY.know.ask)], ['read', 900], ['answer', typeMs(COPY.know.answer, LOOP_USER_CPS)], ['note', 1100],
] as const satisfies CueList<string>;
/**
 * The checklist as the product draws it, whole: what was written down before this question, and the field the answer
 * fills, which the picture lists first so it is in view where the checklist is short (a phone).
 */
function knowChecklist(answered: boolean) {
  const filled: readonly string[] = answered ? [...COPY.know.before, COPY.know.fills] : COPY.know.before;
  const step = personaInformation(new Set(filled), 0)[KNOW.id];
  const first = step.schema.filter(field => field.id === COPY.know.fills);
  return { [KNOW.id]: { ...step, schema: [...first, ...step.schema.filter(field => field.id !== COPY.know.fills)] } };
}
function KnowPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(KNOW_CUES, ms);
  return (
    <div className={styles.split}>
      <div>
        <Feed>
          <Coach step={KNOW} text={typedAt(COPY.know.ask, at.ask)} whole={at.ask.done} />
          <Arrive when={at.answer.done}><MentorUserMessage stepLabel={label(KNOW)} text={COPY.know.answer} /></Arrive>
        </Feed>
      </div>
      <div className={styles.aside}>
        <CaptureChecklist steps={[KNOW]} information={knowChecklist(at.note.on)} valid={{}} edits={{}} selectedStepId={KNOW.id}
          editable manual={false} locked confirmable={() => false} confirmation={() => 'none'} saveState={{}} conflicts={{}}
          resolving={null} onEdit={noop} onComposition={noop} onResolve={noop} onReview={noop} onRecoverConfirmation={noop}
          onKeepConflict={noop} onRetrySave={noop} />
      </div>
    </div>
  );
}

/* 诊断与平台对标: where the figures come from, the searches running then done, the benchmark table. */
const DIAGNOSE_CUES = [['say', typeMs(COPY.diagnose.fetch)], ['fetch', 2600], ['seen', 500], ['table', 2400]] as const satisfies CueList<string>;
function DiagnosePicture({ ms }: { ms: number | null }) {
  const at = cuesAt(DIAGNOSE_CUES, ms);
  // The table takes the picture over once it arrives: its rows are the point, its source notes run on below.
  if (at.table.on) return <Feed anchor="top"><Arrive className={styles.table}><BenchmarkL /></Arrive></Feed>;
  return (
    <Feed>
      <Coach step={J_STEPS[1]} text={typedAt(COPY.diagnose.fetch, at.say)} whole={at.say.done} />
      <Arrive when={at.fetch.on}><ResearchCallsL local={at.fetch.share} /></Arrive>
    </Feed>
  );
}

/* 定位与执行方案: the one-sentence position, the person agreeing, the step's confirm area. */
const PLAN_CUES = [
  ['position', typeMs(COPY.plan.position)], ['read', 900], ['agree', 700], ['summary', typeMs(COPY.plan.summary)], ['confirm', 1200],
] as const satisfies CueList<string>;
const PLAN_INFORMATION = personaInformation(filledUpTo(J_STEPS.length, []), J_STEPS.length - 1);
function PlanPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(PLAN_CUES, ms);
  return (
    <Feed>
      <Coach step={PLAN} text={typedAt(COPY.plan.position, at.position)} whole={at.position.done} />
      <Arrive when={at.agree.on}><MentorUserMessage stepLabel={label(PLAN)} text={COPY.plan.agree} /></Arrive>
      <Arrive when={at.summary.on}>
        <Coach step={PLAN} kind="summary" text={typedAt(COPY.plan.summary, at.summary)} whole={at.summary.done} />
      </Arrive>
      <Arrive when={at.confirm.on}><ConfirmJ step={PLAN.title} information={PLAN_INFORMATION} /></Arrive>
    </Feed>
  );
}

/* 生成完整运营策略报告: the workbench's own button pressed, then the report written block by block. */
const REPORT_CUES = [['press', 900], ['write', 5200]] as const satisfies CueList<string>;
function ReportPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(REPORT_CUES, ms);
  return (
    <div className={styles.report}>
      <div>{at.write.on ? <Feed><ReportOverviewL reveal={at.write.share} /></Feed> : null}</div>
      <footer className={result.publishBar}>
        <Button size="sm" variant="outline" tabIndex={-1}>{J_REPORT.export}</Button>
        {/* The jury's line starts under this button (JuryModuleL). */}
        <Button size="sm" tabIndex={-1} data-on={at.press.on && !at.write.on ? '' : undefined}>{J_REPORT.generate}</Button>
      </footer>
    </div>
  );
}

const picture = (cues: CueList<string>, Picture: (props: { ms: number | null }) => ReactNode): FlowPicture =>
  ({ totalMs: loopMs(cues), draw: ms => <Picture ms={ms} /> });

/** Step one's pictures, by the stage's `moment` (landing-copy-l-steps.ts). */
export const STEP_ONE_PICTURES: Record<number, FlowPicture> = {
  0: picture(KNOW_CUES, KnowPicture),
  1: picture(DIAGNOSE_CUES, DiagnosePicture),
  2: picture(PLAN_CUES, PlanPicture),
  3: picture(REPORT_CUES, ReportPicture),
};
