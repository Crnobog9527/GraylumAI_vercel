/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, useRef } from 'react';
import {
  MentorChatHeading, MentorChatLog, MentorReply, MentorUserMessage,
} from '@/components/chat-display/mentor-messages';
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from '@/components/chat-display/positioning-chrome';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { arrivedAt, RailJ, readThrough } from '@/components/landing/preview-j/PositioningClipJ';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { ConfirmJ, filledUpTo, personaInformation } from '@/components/landing/preview-j/WorkbenchPartsJ';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { OTHER_PLACEHOLDER, QuestionCardView } from '@/components/opc/question-card';
import { WorkComposer } from '@/components/opc/work-composer';
import { Button } from '@/components/ui/button';
import { J_PERSONA_DIRECTION, J_PERSONA_GOAL, J_PERSONA_ON_CAMERA, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT, J_TAKEOVER_MOMENTS, type TakeoverLine } from '@/lib/landing/landing-copy-j-takeover';
import { L_OPENING } from '@/lib/landing/landing-copy-l-steps';
import { L_CLIP_PARTS } from './RealPartsL';
import styles from './picture-l.module.css';

const noop = () => undefined;
const QUESTIONS = { goal: J_PERSONA_GOAL, camera: J_PERSONA_ON_CAMERA, direction: J_PERSONA_DIRECTION } as const;
type Line = TakeoverLine & { opening?: boolean };

/** A moment's messages for sample L: the first moment opens with the coach (主动引导), not with the person. */
function script(moment: number): readonly Line[] {
  const lines = J_TAKEOVER_MOMENTS[moment]?.lines ?? [];
  if (moment !== 0) return lines;
  const [, first, ...rest] = lines;
  return [{ ...first, opening: true, text: first.text.replace(L_OPENING.replace, L_OPENING.with) }, ...rest];
}

/**
 * Sample L's step one picture (Owner 2026-10-17: "落地页所有产品界面的这个组件，你不要自己再重新写一遍"): the positioning
 * workspace put together from the product's own display components, the ones the product page renders
 * (chat-display: header, step strip, the message list and its bubbles, the checklist column; CaptureChecklist; the
 * question card docked in the real message box, WorkComposer; StepConfirmCard; the research record and benchmark
 * table; RealPartsL's report dialog). Sample J's script plays through it; the sidebar is sample J's (the product's
 * workspace frame is not a display component yet). Only the frame around them is this page's: the grid and the scroll
 * that keeps the newest message and the message box in view, as the product page does. A picture: inert.
 */
export function PositioningPictureL({ moment, local }: { moment: number; local: number }) {
  const current = J_TAKEOVER_MOMENTS[moment] ?? J_TAKEOVER_MOMENTS[0];
  const step = current.step;
  const chatMoment = step === 3 ? 2 : moment;
  const all = script(chatMoment);
  const lines = step === 3 ? all : all.slice(0, arrivedAt(local, all.length));
  const shownStep = Math.min(step, 2);
  const stepTitle = J_STEPS[shownStep].title;
  const done = step === 3 || local >= 0.97;
  const confirmed = step === 3 ? 3 : step + (done ? 1 : 0);
  const information = personaInformation(filledUpTo(chatMoment, lines), confirmed);
  const valid = Object.fromEntries(J_STEPS.map((item, index) => [item.id, index < confirmed]));
  const fetchLocal = step === 3 ? 1 : Math.max(0, local * 3 - 1.4);
  const last = lines[lines.length - 1];
  // The open question sits docked above the message box, as on the product page; answered, it is gone.
  const question = last?.role === 'coach' && last.card && last.card in QUESTIONS ? QUESTIONS[last.card as keyof typeof QUESTIONS] : null;
  const confirming = step < 3 && lines.some(line => line.card === 'confirm');

  const log = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const reading = step === 3 ? 1 : readThrough(local, all.length);
  useLayoutEffect(() => {
    const node = log.current;
    const newest = node?.querySelector<HTMLElement>('[data-line]:last-of-type');
    if (node && newest) {
      const extra = Math.max(0, newest.offsetHeight + 24 - node.clientHeight);
      node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, Math.max(0, newest.offsetTop - 12 + extra * reading));
    }
    if (column.current) column.current.scrollTop = column.current.scrollHeight;
  }, [moment, lines.length, reading, question]);

  return (
    <div className={takeover.app}>
      <RailJ published={step === 3} />
      <section className={styles.column} inert>
        <div ref={column} className={styles.scroll}>
          <PositioningHeader title="我的定位分析" status={`整体规划 · ${step === 3 ? '已确认' : '进行中'}`} />
          <PositioningStepStrip steps={J_STEPS.map(item => ({ id: item.id, title: item.title, valid: valid[item.id] }))}
            selectedId={J_STEPS[shownStep].id} />
          <MentorChatHeading />
          <MentorChatLog logRef={log}>
            {lines.map((line, index) => (
              <div key={`${chatMoment}-${index}`} data-line="" className="space-y-2">
                {line.role === 'user' ? <MentorUserMessage stepLabel={` · ${stepTitle}`} text={line.text} /> : (
                  <MentorReply kind={line.role === 'summary' ? 'summary' : line.opening ? 'opening' : 'reply'}
                    stepLabel={` · ${stepTitle}`} text={line.text} />
                )}
                {line.card === 'fetch' || line.card === 'table' ? L_CLIP_PARTS.card?.(line.card, fetchLocal) : null}
              </div>
            ))}
          </MentorChatLog>
          {confirming ? <ConfirmJ step={stepTitle} information={information} /> : null}
          <div className={styles.composer}>
            <WorkComposer value="" onChange={noop} onSend={noop} label="给 AI 教练的回复" placeholder={OTHER_PLACEHOLDER} maxLength={8000}
              attachment={question ? <QuestionCardView card={question} disabled docked /> : null} />
          </div>
          <footer className={result.publishBar}>
            <Button size="sm" variant="outline" tabIndex={-1}>{J_REPORT.export}</Button>
            <Button size="sm" variant={step === 3 ? 'default' : 'outline'} tabIndex={-1}>{J_REPORT.generate}</Button>
          </footer>
        </div>
        <span className={styles.demo}>{DEMO_LABEL}</span>
      </section>
      <aside className={takeover.checklist} inert>
        <PositioningResultPanel subtitle="跟着对话自动记录；每一步核对后确认一次">
          <CaptureChecklist steps={J_STEPS} information={information} valid={valid} edits={{}} selectedStepId={J_STEPS[shownStep].id}
            editable manual={false} locked confirmable={() => false} confirmation={() => 'none'} saveState={{}} conflicts={{}}
            resolving={null} onEdit={noop} onComposition={noop} onResolve={noop} onReview={noop} onRecoverConfirmation={noop}
            onKeepConflict={noop} onRetrySave={noop} />
        </PositioningResultPanel>
      </aside>
      {step === 3 ? L_CLIP_PARTS.report?.(current.id === 'report', local) : null}
    </div>
  );
}
