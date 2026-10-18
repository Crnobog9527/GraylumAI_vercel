/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  MentorChatHeading, MentorChatLog, MentorReply, MentorUserMessage,
} from '@/components/chat-display/mentor-messages';
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from '@/components/chat-display/positioning-chrome';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { ConfirmJ, filledUpTo, personaInformation } from '@/components/landing/preview-j/WorkbenchPartsJ';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { OpenQuestionRecord, OTHER_PLACEHOLDER, QuestionCardView } from '@/components/opc/question-card';
import { Button } from '@/components/ui/button';
import { J_PERSONA_DIRECTION, J_PERSONA_ON_CAMERA, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT, J_TAKEOVER_MOMENTS, type TakeoverLine } from '@/lib/landing/landing-copy-j-takeover';
import { L_GOAL_CARD, L_POSITIONING_MOMENTS } from '@/lib/landing/landing-copy-l-positioning';
import type { MomentAt } from '@/lib/landing/step-one-timeline';
import { ComposerL } from './ComposerL';
import { RailL } from './RailL';
import { L_CLIP_PARTS } from './RealPartsL';
import { Caret, TypingFrame } from './typing-l';
import styles from './picture-l.module.css';

const noop = () => undefined;
const QUESTIONS = { goal: L_GOAL_CARD, camera: J_PERSONA_ON_CAMERA, direction: J_PERSONA_DIRECTION } as const;
type Line = TakeoverLine & { opening?: boolean };

/** A moment's messages: sample L's own script (round six), opening with the coach. */
export const stepOneScript = (moment: number): readonly Line[] => L_POSITIONING_MOMENTS[moment]?.lines ?? [];

/** The current line shows in the conversation once sent (the person's) or once the coach starts writing it. */
const VISIBLE = new Set(['send', 'stream', 'card', 'hold']);
const isQuestion = (line?: Line) => line?.role === 'coach' && Boolean(line.card && line.card in QUESTIONS);

/**
 * Sample L's step one picture (Owner 2026-10-17: "落地页所有产品界面的这个组件，你不要自己再重新写一遍"): the positioning
 * workspace put together from the product's own display components (chat-display: header, step strip, the message list
 * and its bubbles, the checklist column; CaptureChecklist; the question card docked in the product's message box,
 * ComposerL; StepConfirmCard; the research record and benchmark table; RealPartsL's report dialog). Sample L's own
 * script plays through it (landing-copy-l-positioning.ts); the sidebar is sample J's.
 *
 * Round seven (T2, T8): it shows the stage `at` a point of its clock (step-one-timeline.ts): the person's message typed
 * into the message box, then sent; the coach's typed out with a caret; its card; the confirm area at the end. `at` null
 * is the stage finished (no JavaScript, reduced motion). The visitor may scroll the conversation to read it (round
 * eight: that does not move the step on). Only the frame around the components is this page's.
 */
export function PositioningPictureL({ moment, at, reportLocal = 1 }: { moment: number; at: MomentAt | null; reportLocal?: number }) {
  const current = J_TAKEOVER_MOMENTS[moment] ?? J_TAKEOVER_MOMENTS[0];
  const step = current.step;
  const chatMoment = step === 3 ? 2 : moment;
  const all = stepOneScript(chatMoment);
  const playing = step < 3 && at !== null && at.phase !== 'end';
  const now = playing ? all[at.index] : undefined;
  const nowShown = Boolean(now && VISIBLE.has(at!.phase));
  const lines = playing ? all.slice(0, at.index + (nowShown ? 1 : 0)) : all;
  const streaming = playing && at.phase === 'stream';
  const composing = playing && at.phase === 'compose' ? now!.text.slice(0, at.chars) : '';
  // A line is whole once written: what it brings (its card, the step's confirm area, its fields) comes after.
  const whole = (index: number) => !playing || index < at.index || (index === at.index && (at.phase === 'card' || at.phase === 'hold' || at.phase === 'send'));
  const wholeLines = lines.filter((_, index) => whole(index));
  const shownStep = Math.min(step, 2);
  const stepTitle = J_STEPS[shownStep].title;
  const confirmed = step === 3 ? 3 : step + (playing ? 0 : 1);
  const information = personaInformation(filledUpTo(chatMoment, wholeLines), confirmed);
  const valid = Object.fromEntries(J_STEPS.map((item, index) => [item.id, index < confirmed]));
  const cardLocal = (index: number) => (playing && index === at.index && at.phase === 'card' ? at.share : 1);
  // The open question: the newest whole coach line asking one, until the person's answer is sent. Folded in the
  // conversation while it is first read, then docked on the message box while the person answers (as on the product page).
  const lastWhole = wholeLines[wholeLines.length - 1];
  const asked = isQuestion(lastWhole) ? lastWhole : undefined;
  const question = step < 3 && asked ? QUESTIONS[asked.card as keyof typeof QUESTIONS] : null;
  const docked = Boolean(question) && (!playing || at.phase === 'compose' || at.phase === 'pick' || (at.phase === 'hold' && at.share >= 0.4));
  // Round eleven (X1): the person answers the card by picking an option, as on the product page (the option's words are
  // what is sent). The highlight comes onto the option, it is pressed, then the message goes and the card closes.
  const picking = playing && at.phase === 'pick' && now?.pick !== undefined ? now.pick : undefined;
  const pickState = picking === undefined || at!.share < 0.25 ? undefined : at!.share < 0.7 ? 'over' : 'pressed';
  const confirming = step < 3 && wholeLines.some(line => line.card === 'confirm');

  const log = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // The conversation follows its newest line until the visitor scrolls it; the pointer leaving gives it back.
  const [follow, setFollow] = useState(true);
  useLayoutEffect(() => {
    if (!follow) return;
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
    if (column.current) column.current.scrollTop = column.current.scrollHeight;
  });
  const takeOver = () => setFollow(false);

  return (
    <div className={takeover.app}>
      <RailL published={step === 3} />
      <section className={styles.column} onPointerLeave={() => setFollow(true)}>
        <div ref={column} className={styles.scroll}>
          <div inert><PositioningHeader headingLevel="h2" title="我的定位分析" status={`整体规划 · ${step === 3 ? '已确认' : '进行中'}`} /></div>
          <div inert>
            <PositioningStepStrip steps={J_STEPS.map(item => ({ id: item.id, title: item.title, valid: valid[item.id] }))}
              selectedId={J_STEPS[shownStep].id} />
          </div>
          <div inert><MentorChatHeading /></div>
          {/* The log is the visitor's to scroll (round seven); what it holds is a picture (inert). */}
          <div className={styles.logHost} onWheel={takeOver} onTouchMove={takeOver}>
            <MentorChatLog logRef={log}>
              <div inert className="space-y-3">
                {lines.map((line, index) => {
                  const live = streaming && index === at!.index;
                  const text = live ? line.text.slice(0, at!.chars) : line.text;
                  return (
                    <div key={`${chatMoment}-${index}`} data-line="" className="space-y-2">
                      {line.role === 'user' ? <MentorUserMessage stepLabel={` · ${stepTitle}`} text={line.text} /> : (
                        <TypingFrame typing={live}>
                          <MentorReply kind={line.role === 'summary' ? 'summary' : line.opening ? 'opening' : 'reply'}
                            stepLabel={` · ${stepTitle}`} text={text} live={live} />
                        </TypingFrame>
                      )}
                      {whole(index) && (line.card === 'fetch' || line.card === 'table') ? L_CLIP_PARTS.card?.(line.card, cardLocal(index)) : null}
                      {question && !docked && line === asked ? <OpenQuestionRecord card={question} /> : null}
                    </div>
                  );
                })}
              </div>
            </MentorChatLog>
          </div>
          {confirming ? <div inert><ConfirmJ step={stepTitle} information={information} /></div> : null}
        </div>
        <div className={styles.bottom} inert>
          <div className={styles.composer}>
            <ComposerL label="给 AI 教练的回复" placeholder={OTHER_PLACEHOLDER} paragraphs={[[composing]]}
              caret={composing ? <Caret /> : undefined}
              attachment={question && docked ? (
                <div className={styles.picking} data-pick={pickState ? picking : undefined} data-state={pickState}>
                  <QuestionCardView card={question} docked />
                </div>
              ) : null} />
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
      {step === 3 ? L_CLIP_PARTS.report?.(current.id === 'report', reportLocal) : null}
    </div>
  );
}
