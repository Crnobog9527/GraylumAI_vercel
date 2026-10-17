/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ContentDraftView } from '@/components/opc/content-draft-view';
import {
  RuntimeHeader, RuntimePendingMessage, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView,
} from '@/components/chat-display/runtime-messages';
import * as runtime from '@/components/chat-display/fixtures/runtime';
import { ProductFrame } from './ProductFrame';

/** One feature page's product screen: the product's own display components with the shared example data; every callback is a no-op. */
export function DemoContent() {
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
