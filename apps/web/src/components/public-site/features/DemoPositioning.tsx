/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { CaptureChecklist } from '@/components/opc/capture-checklist';
import { QuestionCardView } from '@/components/opc/question-card';
import {
  MentorChatHeading, MentorChatLog, MentorPendingMessage, MentorReply, MentorTurnGroup, MentorUserMessage, MentorWelcome,
} from '@/components/chat-display/mentor-messages';
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from '@/components/chat-display/positioning-chrome';
import * as capture from '@/components/chat-display/fixtures/capture';
import * as positioning from '@/components/chat-display/fixtures/positioning';
import { ProductFrame } from './ProductFrame';

const noop = () => undefined;

/** One feature page's product screen: the product's own display components with the shared example data; every callback is a no-op. */
export function DemoPositioning() {
  const steps = capture.SAMPLE_CHECKLIST_STEPS;
  return (
    <ProductFrame label="定位分析的产品界面示例" caption="示例界面，内容为虚构的示例数据">
      <PositioningHeader {...positioning.SAMPLE_POSITIONING_HEADER} headingLevel="h2" />
      <div className="mt-3"><PositioningStepStrip steps={positioning.SAMPLE_POSITIONING_STEPS} selectedId={positioning.SAMPLE_POSITIONING_SELECTED_STEP} onSelect={noop} /></div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-3">
          <MentorChatHeading />
          <MentorChatLog>
            <MentorWelcome text={positioning.SAMPLE_MENTOR_WELCOME} />
            {positioning.SAMPLE_MENTOR_TURNS.map(turn => (
              <MentorTurnGroup key={turn.executionId} executionId={turn.executionId}>
                {turn.user ? <MentorUserMessage {...turn.user} /> : null}
                <MentorReply {...turn.reply} />
              </MentorTurnGroup>
            ))}
            <MentorPendingMessage {...positioning.SAMPLE_MENTOR_PENDING} sending />
          </MentorChatLog>
          <QuestionCardView card={positioning.SAMPLE_QUESTION_CARD} docked />
        </div>
        <PositioningResultPanel subtitle={positioning.SAMPLE_POSITIONING_PANEL_SUBTITLE}>
          <CaptureChecklist
            steps={steps} information={capture.SAMPLE_CHECKLIST_INFORMATION} valid={{ about: false, diagnose: false, plan: false }}
            edits={{}} selectedStepId="about" editable manual={false} locked
            confirmable={() => false} confirmation={() => 'none'} saveState={{}} conflicts={{}} resolving={null}
            onEdit={noop} onComposition={noop} onResolve={noop} onReview={noop} onRecoverConfirmation={noop}
            onKeepConflict={noop} onRetrySave={noop}
          />
        </PositioningResultPanel>
      </div>
    </ProductFrame>
  );
}
