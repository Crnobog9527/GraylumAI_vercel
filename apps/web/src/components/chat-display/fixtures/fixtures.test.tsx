/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionCardView } from '@/components/opc/question-card';
import { ContentDraftView } from '@/components/opc/content-draft-view';
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from '../positioning-chrome';
import { MentorChatHeading, MentorChatLog, MentorPendingMessage, MentorReply, MentorTurnGroup, MentorUserMessage, MentorWelcome } from '../mentor-messages';
import { RuntimeHeader, RuntimePendingMessage, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView } from '../runtime-messages';
import * as P from './positioning';
import * as R from './runtime';

// The landing page renders the shared fixtures exactly like this: they must stay renderable.
it('renders the positioning workspace from the shared fixtures', () => {
  const html = renderToStaticMarkup(<>
    <PositioningHeader {...P.SAMPLE_POSITIONING_HEADER} showExpand/>
    <PositioningStepStrip steps={P.SAMPLE_POSITIONING_STEPS} selectedId={P.SAMPLE_POSITIONING_SELECTED_STEP}/>
    <MentorChatHeading/>
    <MentorChatLog>
      <MentorWelcome text={P.SAMPLE_MENTOR_WELCOME}/>
      {P.SAMPLE_MENTOR_TURNS.map(turn => <MentorTurnGroup key={turn.executionId} executionId={turn.executionId}>
        {turn.user && <MentorUserMessage {...turn.user}/>}<MentorReply {...turn.reply}/></MentorTurnGroup>)}
      <MentorPendingMessage {...P.SAMPLE_MENTOR_PENDING} sending/>
    </MentorChatLog>
    <QuestionCardView card={P.SAMPLE_QUESTION_CARD} docked/>
    <PositioningResultPanel subtitle={P.SAMPLE_POSITIONING_PANEL_SUBTITLE}><p>清单</p></PositioningResultPanel>
  </>);
  for (const text of [P.SAMPLE_POSITIONING_HEADER.title, '✓ 了解你', '主动引导', '本步小结卡', P.SAMPLE_MENTOR_PENDING.text,
    P.SAMPLE_QUESTION_CARD.question, '推荐', '定位清单']) expect(html).toContain(text);
});

it('renders the work conversation from the shared fixtures', () => {
  const html = renderToStaticMarkup(<>
    <RuntimeHeader {...R.SAMPLE_RUNTIME_HEADER}/>
    {R.SAMPLE_RUNTIME_TURNS.map(turn => <RuntimeTurnView key={turn.id} dateLabel={turn.dateLabel} userText={turn.userText} completed={turn.completed}>
      {turn.proposal ? <RuntimeProposal adopted={turn.proposal.adopted} text={turn.reply}/> : <RuntimeReply text={turn.reply}/>}
    </RuntimeTurnView>)}
    <RuntimePendingMessage text={R.SAMPLE_RUNTIME_PENDING} sending/>
    <ContentDraftView {...R.SAMPLE_CONTENT_DRAFT}>
      <RuntimeResultsSection isVideo versions={R.SAMPLE_RESULT_VERSIONS} currentScriptId={R.SAMPLE_CURRENT_SCRIPT_ID}
        saved={R.SAMPLE_SAVED_RESULTS} libraryHref="/app/library"/>
    </ContentDraftView>
  </>);
  for (const text of [R.SAMPLE_RUNTIME_HEADER.title, '建议稿', '今天 10:30', R.SAMPLE_RUNTIME_PENDING, '正文稿件', '分镜与剪辑建议',
    ' · 匹配当前口播稿', '其他 Skill 成果 · 第 1 版']) expect(html).toContain(text);
});
