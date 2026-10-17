/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, useRef } from 'react';
import {
  MentorChatHeading, MentorChatLog, MentorReply, MentorUserMessage,
} from '@/components/chat-display/mentor-messages';
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from '@/components/chat-display/positioning-chrome';
import { arrivedAt, RailJ } from '@/components/landing/preview-j/PositioningClipJ';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { ConfirmJ, filledUpTo, personaInformation } from '@/components/landing/preview-j/WorkbenchPartsJ';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { OpenQuestionRecord, OTHER_PLACEHOLDER, QuestionCardView } from '@/components/opc/question-card';
import { WorkComposer } from '@/components/opc/work-composer';
import { Button } from '@/components/ui/button';
import { J_PERSONA_DIRECTION, J_PERSONA_ON_CAMERA, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT, J_TAKEOVER_MOMENTS, type TakeoverLine } from '@/lib/landing/landing-copy-j-takeover';
import { L_GOAL_CARD, L_POSITIONING_MOMENTS } from '@/lib/landing/landing-copy-l-positioning';
import { L_CLIP_PARTS } from './RealPartsL';
import styles from './picture-l.module.css';

const noop = () => undefined;
const QUESTIONS = { goal: L_GOAL_CARD, camera: J_PERSONA_ON_CAMERA, direction: J_PERSONA_DIRECTION } as const;
type Line = TakeoverLine & { opening?: boolean };

/** A moment's messages: sample L's own script (round six), opening with the coach. */
const script = (moment: number): readonly Line[] => L_POSITIONING_MOMENTS[moment]?.lines ?? [];

/**
 * How far the newest message is, 0 → 1, at `local` of a moment with `count` messages: the first half of its time it is
 * being written (round six, S5: streamed as in the product), the second half it is read through.
 */
function newestShare(local: number, count: number) {
  const position = local * count * 1.15;
  return arrivedAt(local, count) < count
    ? position - Math.floor(position)
    : Math.min(1, Math.max(0, (position - (count - 1)) / (count * 1.15 - (count - 1))));
}

/**
 * Sample L's step one picture (Owner 2026-10-17: "落地页所有产品界面的这个组件，你不要自己再重新写一遍"): the positioning
 * workspace put together from the product's own display components, the ones the product page renders
 * (chat-display: header, step strip, the message list and its bubbles, the checklist column; CaptureChecklist; the
 * question card docked in the real message box, WorkComposer; StepConfirmCard; the research record and benchmark
 * table; RealPartsL's report dialog). Sample L's own script plays through it (landing-copy-l-positioning.ts); the sidebar is sample J's (the product's
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
  const share = step === 3 ? 1 : newestShare(local, all.length);
  const written = Math.min(1, share / 0.5);
  const reading = Math.max(0, Math.min(1, (share - 0.5) / 0.5));
  const last_ = lines[lines.length - 1];
  const streaming = written < 1 && last_ !== undefined && last_.role !== 'user';
  // What follows a message (its card, the step's confirm area) comes once the message is written.
  const confirming = step < 3 && lines.some(line => line.card === 'confirm') && !(streaming && last_?.card === 'confirm');
  // As on the product page, an open question is either folded into one line in the conversation or docked on the message
  // box: folded while its message is being read, docked once it has been read (round six: the message box stays whole).
  const docked = Boolean(question) && reading >= 0.55;

  const log = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = log.current;
    const newest = node?.querySelector<HTMLElement>('[data-line]:last-of-type');
    const box = column.current;
    if (!node || !newest || !box) return;
    // The log puts the newest message at its top, then reads on through a long one as the scroll goes.
    // Positions inside the log are measured from the log itself (it is not the messages' offset parent).
    const top = newest.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    const extra = Math.max(0, newest.offsetHeight + 24 - node.clientHeight);
    node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, Math.max(0, top - 12 + extra * reading));
    // The conversation area follows the reading too: first from the log's top, then on to what follows it (the
    // step's confirm area). The message box stays pinned below it, whole.
    const end = box.scrollHeight - box.clientHeight;
    const logTop = Math.min(end, Math.max(0, box.scrollTop + node.getBoundingClientRect().top - box.getBoundingClientRect().top - 4));
    box.scrollTop = logTop + (end - logTop) * reading;
  }, [moment, lines.length, reading, question, docked]);

  return (
    <div className={takeover.app}>
      <RailJ published={step === 3} launched />
      <section className={styles.column} inert>
        <div ref={column} className={styles.scroll}>
          <PositioningHeader headingLevel="h2" title="我的定位分析" status={`整体规划 · ${step === 3 ? '已确认' : '进行中'}`} />
          <PositioningStepStrip steps={J_STEPS.map(item => ({ id: item.id, title: item.title, valid: valid[item.id] }))}
            selectedId={J_STEPS[shownStep].id} />
          <MentorChatHeading />
          <MentorChatLog logRef={log}>
            {lines.map((line, index) => {
              const live = streaming && index === lines.length - 1;
              const text = live ? line.text.slice(0, Math.max(1, Math.round(line.text.length * written))) : line.text;
              return (
              <div key={`${chatMoment}-${index}`} data-line="" className="space-y-2">
                {line.role === 'user' ? <MentorUserMessage stepLabel={` · ${stepTitle}`} text={line.text} /> : (
                  <MentorReply kind={line.role === 'summary' ? 'summary' : line.opening ? 'opening' : 'reply'}
                    stepLabel={` · ${stepTitle}`} text={text} live={live} />
                )}
                {!live && (line.card === 'fetch' || line.card === 'table') ? L_CLIP_PARTS.card?.(line.card, fetchLocal) : null}
                {question && !docked && !live && line === last ? <OpenQuestionRecord card={question} /> : null}
              </div>
              );
            })}
          </MentorChatLog>
          {confirming ? <ConfirmJ step={stepTitle} information={information} /> : null}
        </div>
        <div className={styles.bottom}>
          <div className={styles.composer}>
            <WorkComposer value="" onChange={noop} onSend={noop} label="给 AI 教练的回复" placeholder={OTHER_PLACEHOLDER} maxLength={8000}
              attachment={question && docked ? <QuestionCardView card={question} disabled docked /> : null} />
          </div>
          <footer className={result.publishBar}>
            <Button size="sm" variant="outline" tabIndex={-1}>{J_REPORT.export}</Button>
            <Button size="sm" variant={step === 3 ? 'default' : 'outline'} tabIndex={-1}>{J_REPORT.generate}</Button>
          </footer>
        </div>
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
