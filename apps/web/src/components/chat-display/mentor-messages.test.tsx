/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MentorChatHeading, MentorChatLog, MentorLiveReply, MentorPendingMessage, MentorReply, MentorTurnGroup, MentorUserMessage, MentorWelcome,
} from './mentor-messages';

// Sample data only: no queries or sign-in, as the landing page renders it.
it('renders a whole mentor chat from sample data', () => {
  const html = renderToStaticMarkup(<>
    <MentorChatHeading/>
    <MentorChatLog>
      <MentorWelcome text="我会在同一个对话里陪你完成全部步骤。"/>
      <MentorTurnGroup executionId="sample-1">
        <MentorUserMessage stepLabel=" · 了解你" text="我是做烘焙的，想在小红书接单。"/>
        <MentorReply kind="reply" stepLabel=" · 了解你" text="先说说你**现在每周**能拿出多少时间？"/>
      </MentorTurnGroup>
      <MentorTurnGroup executionId="sample-2">
        <MentorReply kind="summary" stepLabel=" · 了解你" text="本步小结：已知你的行业和目标。" summaryHint/>
      </MentorTurnGroup>
      <MentorPendingMessage requestId="r1" stepTitle="了解你" text="每周大概 5 小时" sending/>
      <MentorLiveReply text=""/>
    </MentorChatLog>
  </>);
  for (const text of ['全程同一对话', '我会在同一个对话里陪你完成全部步骤。', '你 · 了解你', '我是做烘焙的，想在小红书接单。',
    '<strong>现在每周</strong>', '本步小结卡', '小结不会自动确认这一步', '每周大概 5 小时', '正在思考…']) expect(html).toContain(text);
  expect(html).toContain('data-execution-id="sample-1"');
  expect(html).toContain('role="log"');
});

it('labels the host-started opening and omits the summary line elsewhere', () => {
  const html = renderToStaticMarkup(<MentorReply kind="opening" stepLabel="" text="我们先从你的目标开始。" summaryHint={false}/>);
  expect(html).toContain('AI 自媒体陪跑教练 · 主动引导');
  expect(html).not.toContain('本步小结');
  expect(renderToStaticMarkup(<MentorLiveReply text="正在写"/>)).toContain('正在写');
});
