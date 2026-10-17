/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { QuestionCard } from '@repo/api/src/shared/agentTurn';
import type { PositioningStepChip } from '../positioning-chrome';
import type { MentorReplyKind } from '../mentor-messages';

/**
 * Sample data for the positioning display components, shared by the landing page and the
 * component tests. Made-up example content only: no real user, no real account.
 */

export const SAMPLE_POSITIONING_HEADER = { title: '我的定位分析', status: '整体规划 · 进行中' };

export const SAMPLE_POSITIONING_STEPS: PositioningStepChip[] = [
  { id: 'about', title: '了解你', valid: true },
  { id: 'diagnose', title: '诊断与平台对标', valid: false },
  { id: 'plan', title: '定位与执行方案', valid: false, disabled: true },
];
export const SAMPLE_POSITIONING_SELECTED_STEP = 'diagnose';

export const SAMPLE_POSITIONING_PANEL_SUBTITLE = '跟着对话自动记录；每一步核对后确认一次';

export const SAMPLE_MENTOR_WELCOME = '我会在同一个对话里陪你完成全部步骤。你聊到的信息会自动记到右侧清单的对应栏目，每一步齐了以后由你核对并确认一次。';

export type SampleMentorTurn = {
  executionId: string;
  /** Absent for a turn the host started itself. */
  user?: { stepLabel: string; text: string };
  reply: { kind: MentorReplyKind; stepLabel: string; text: string; summaryHint?: boolean };
};

export const SAMPLE_MENTOR_TURNS: SampleMentorTurn[] = [
  {
    executionId: 'sample-turn-1',
    reply: { kind: 'opening', stepLabel: ' · 了解你', text: '我们先从你的目标开始：你希望做自媒体以后，**三个月内**带来什么变化？' },
  },
  {
    executionId: 'sample-turn-2',
    user: { stepLabel: ' · 了解你', text: '我是做烘焙的，想在小红书接定制蛋糕的单。' },
    reply: { kind: 'reply', stepLabel: ' · 了解你', text: '明白了。先说说你**现在每周**能拿出多少时间做内容？' },
  },
  {
    executionId: 'sample-turn-3',
    reply: { kind: 'summary', stepLabel: ' · 了解你', text: '本步小结：烘焙从业者，目标是小红书接定制单，每周可投入 3–10 小时。', summaryHint: true },
  },
];

export const SAMPLE_MENTOR_PENDING = { requestId: 'sample-request', stepTitle: '诊断与平台对标', text: '我还想同时做抖音，可以吗？' };

export const SAMPLE_QUESTION_CARD: QuestionCard = {
  question: '你每周能拿出多少时间做内容？',
  options: ['3 小时以内', '3–10 小时', '10 小时以上'],
  recommended: 1,
  recommendationReason: '大多数新手从这个量开始最稳，既能保持更新又不容易放弃。',
};
