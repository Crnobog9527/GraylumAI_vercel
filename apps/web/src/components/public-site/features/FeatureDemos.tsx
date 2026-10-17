/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ContentDraftView } from '@/components/opc/content-draft-view';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import { QuestionCardView } from '@/components/opc/question-card';
import { DocumentList, SpacePanel, UploadPanel } from '@/components/library/my-documents-view';
import { JuryCanvasPlayer } from '@/components/landing/preview-jury/JuryCanvasPlayer';
import { JuryReader } from '@/components/landing/preview-jury/JuryReader';
import {
  MentorChatHeading, MentorChatLog, MentorPendingMessage, MentorReply, MentorTurnGroup, MentorUserMessage, MentorWelcome,
} from '@/components/chat-display/mentor-messages';
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from '@/components/chat-display/positioning-chrome';
import {
  RuntimeHeader, RuntimePendingMessage, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView,
} from '@/components/chat-display/runtime-messages';
import * as capture from '@/components/chat-display/fixtures/capture';
import * as jury from '@/components/chat-display/fixtures/jury';
import * as library from '@/components/chat-display/fixtures/library';
import * as positioning from '@/components/chat-display/fixtures/positioning';
import * as runtime from '@/components/chat-display/fixtures/runtime';
import type { FeatureSlug } from '@/lib/seo/content/features';
import { ProductFrame } from './ProductFrame';

/**
 * The product screens on the feature pages (Owner 2026-10-17: the landing page's product interfaces are the real
 * components, never redrawn). Each demo renders the product's own display components with the shared example data;
 * every callback is a no-op because nothing here talks to a server.
 */
const noop = () => undefined;
const noopAsync = async () => undefined;

function PositioningDemo() {
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

function ContentDemo() {
  return (
    <ProductFrame label="选题与创作的产品界面示例" caption="示例界面，内容为虚构的示例数据">
      <RuntimeHeader {...runtime.SAMPLE_RUNTIME_HEADER} headingLevel="h2" />
      <div className="mt-3 space-y-3">
        {runtime.SAMPLE_RUNTIME_TURNS.map(turn => (
          <RuntimeTurnView key={turn.id} dateLabel={turn.dateLabel} userText={turn.userText} completed={turn.completed}>
            {turn.proposal ? <RuntimeProposal adopted={turn.proposal.adopted} text={turn.reply} /> : <RuntimeReply text={turn.reply} />}
          </RuntimeTurnView>
        ))}
        <RuntimePendingMessage text={runtime.SAMPLE_RUNTIME_PENDING} sending />
      </div>
      <div className="mt-4">
        <ContentDraftView {...runtime.SAMPLE_CONTENT_DRAFT}>
          <RuntimeResultsSection isVideo versions={runtime.SAMPLE_RESULT_VERSIONS} currentScriptId={runtime.SAMPLE_CURRENT_SCRIPT_ID}
            saved={runtime.SAMPLE_SAVED_RESULTS} libraryHref="/features/library" />
        </ContentDraftView>
      </div>
    </ProductFrame>
  );
}

function LibraryDemo() {
  return (
    <ProductFrame label="资料库的产品界面示例" caption="示例界面，文件名为虚构的示例数据">
      <div className="space-y-4">
        <UploadPanel uploadEnabled spaceKnown {...library.SAMPLE_LIBRARY_SPACE} uploads={library.SAMPLE_LIBRARY_UPLOADS}
          onAdd={noop} onRetry={noop} onDismiss={noopAsync} />
        <SpacePanel {...library.SAMPLE_LIBRARY_SPACE} />
        <DocumentList documents={library.SAMPLE_LIBRARY_DOCUMENTS} ready onOpen={noop} onDownload={noop} onDelete={noop} onPurpose={noop} />
      </div>
    </ProductFrame>
  );
}

function JuryDemo() {
  return (
    <div className="space-y-8">
      <ProductFrame label="评审团审阅过程的示例" caption="示例评审：使用示例报告和示例评审名字，不是真实用户的报告">
        <div style={{ height: 560 }}>
          <JuryCanvasPlayer data={jury.SAMPLE_JURY_CASE} names={jury.SAMPLE_JURY_NAMES} brief speed={1} />
        </div>
      </ProductFrame>
      <ProductFrame label="评审团结果页的示例" caption="示例结果页：每一章用修订还是原文，由你逐章决定">
        <JuryReader detail={jury.SAMPLE_JURY_SCENARIO.detail} names={jury.SAMPLE_JURY_NAMES}
          source={jury.SAMPLE_JURY_READER_SOURCE} actions={jury.SAMPLE_JURY_ADOPT_ACTIONS} />
      </ProductFrame>
    </div>
  );
}

export function FeatureDemo({ slug }: { slug: FeatureSlug }) {
  switch (slug) {
    case 'positioning': return <PositioningDemo />;
    case 'content': return <ContentDemo />;
    case 'library': return <LibraryDemo />;
    case 'jury': return <JuryDemo />;
  }
}
