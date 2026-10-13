/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { QuestionCard } from '@repo/api/src/shared/agentTurn';
import type { FieldValue, StepInformation } from '@/components/opc/capture-state';

/**
 * The landing demo's script: a made-up beginner (示例) going through the first positioning step with the
 * real conversation components. Pure data and a reducer; nothing here reaches a server, a model or credits.
 * The case is fictional and carries no follower, income or growth numbers.
 */
export const DEMO_LABEL = '示例';
export const DEMO_NOTE = '示例对话：人物和内容为虚构，用来演示教练怎么工作。不连接服务器，不调用模型，不扣积分。';

export type DemoMessage = { id: string; role: 'user' | 'assistant'; label: string; text: string; summary?: boolean };
export type DemoPanel = 'chat' | 'checklist' | 'report';
export type DemoPhase = 'q1' | 'q2' | 'summary' | 'confirmed';

export const DEMO_STEPS = [
  { id: 'you', title: '你是谁' },
  { id: 'direction', title: '方向判断' },
  { id: 'benchmark', title: '找对标' },
] as const;

const FIELDS = [
  { id: 'experience', title: '可以讲的经验', required: true, elicitation: 'user_fact' as const },
  { id: 'time', title: '每周能投入的时间', required: true, elicitation: 'user_fact' as const },
  { id: 'audience', title: '想帮的人', required: true, elicitation: 'user_fact' as const },
];
const LATER = {
  direction: [{ id: 'direction', title: '账号方向', required: true }, { id: 'risk', title: '教练的提醒', required: false }],
  benchmark: [{ id: 'accounts', title: '对标账号', required: true }],
};

export const OPENING =
  '我会在同一个对话里陪你完成全部步骤。你聊到的信息会自动记到右侧清单的对应栏目，每一步齐了以后由你核对并确认一次。';

const FIRST_USER = '我在加拿大做牙科助理，下班后和周末有点时间，想做个账号，但不知道能拍什么。';

const FIRST_REPLY = '先不急着定拍什么。我们先看你手里有什么：经历、资源，还有你愿意长期聊的话题。\n\n' +
  '你在工作里，最常被身边的人问到的是哪类问题？选最接近的一项，或者直接说你的情况。';

export const QUESTION_ONE: QuestionCard = {
  question: '你在工作里，最常被身边的人问到的是哪类问题？',
  options: ['看牙怎么省钱、保险怎么用', '日常怎么护理牙齿', '怎么在加拿大入行做牙科助理'],
  recommended: 2,
  recommendationReason: '这是你亲身走过的路，别人很难替代；想入行的人也更愿意为具体的帮助付费。',
} as QuestionCard;

export const QUESTION_TWO: QuestionCard = {
  question: '你更想帮谁？',
  options: ['刚到加拿大、想转行的新移民', '在读的牙科助理学生', '已经入行、想换工作的同行'],
  recommended: 0,
  recommendationReason: '这群人最着急、最愿意行动，你走过的每一步对他们都有用。',
} as QuestionCard;

const REPLY_RECOMMENDED = '好，这条路是你自己走过的，别人很难替代。我先记到右侧「可以讲的经验」，你随时可以改。\n\n下一个问题：你更想帮谁？';
const REPLY_TRUTH = '记下了。说句实话：这类话题牙医和品牌都在讲，你作为助理不占优势，也比较难变现。' +
  '我建议把它当作补充内容，主线放在你自己的入行经历上。\n\n下一个问题：你更想帮谁？';

function summaryText(experience: string, audience: string) {
  return `**本步小结**\n\n- 可以讲的经验：${experience}\n- 每周能投入的时间：下班后和周末\n- 想帮的人：${audience}\n\n` +
    '这一步的必需信息齐了。请在右侧清单核对，确认后我们进入「方向判断」。';
}

export const REPORT_TITLE = '定位报告（示例）';
export const REPORT_INTRO = '示例：全部步骤确认后，教练根据你确认过的信息写出完整报告。下面是这个虚构案例的节选。';
export const REPORT_BODY = [
  '## 一句话定位',
  '帮刚到加拿大的新移民，用下班时间一步步转行做牙科助理。',
  '## 账号三件套',
  '- **名字：** 牙助阿杰的转行笔记',
  '- **简介：** 在加拿大做牙科助理 · 分享从零入行的真实路径',
  '- **头像和封面：** 工作场景实拍，统一浅色调',
  '## 对标拆解',
  '在真实产品里，对标账号的数据由程序实时查出、算出，AI 改不了；这个示例不展示数字。',
  '- **职业转型类账号：** 每条只讲一个具体步骤，评论区答疑多',
  '- **新移民生活类账号：** 用亲身经历开头，信任感强',
  '## 第一个 30 天计划',
  '- 第 1 周：讲清你自己是怎么入行的',
  '- 第 2 周：入行要准备的证书和课程',
  '- 第 3 周：第一份工作怎么找',
  '- 第 4 周：回答评论区最常见的问题',
  '## 变现路线',
  '先用免费内容建立信任，再提供一对一入行咨询，之后整理成入行指南。',
].join('\n\n');

export type DemoState = {
  phase: DemoPhase;
  messages: DemoMessage[];
  values: Record<string, FieldValue>;
  /** Fields the visitor typed in the checklist; shown as theirs and as saved, like the real autosave. */
  typed: string[];
  valid: boolean;
  panel: DemoPanel;
  reportOpen: boolean;
  /** The message that is being "typed" right now; the view reveals it unless motion is reduced. */
  liveId: string | null;
};

const captured = (value: string): FieldValue => ({ value, status: 'provisional', nature: 'fact' });

export function initialDemoState(): DemoState {
  return {
    phase: 'q1',
    messages: [
      { id: 'm0', role: 'assistant', label: '导师主动引导 · 你是谁', text: OPENING },
      { id: 'm1', role: 'user', label: '你 · 你是谁', text: FIRST_USER },
      { id: 'm2', role: 'assistant', label: '导师 · 你是谁', text: FIRST_REPLY },
    ],
    values: { time: captured('下班后和周末') },
    typed: [],
    valid: false,
    panel: 'chat',
    reportOpen: false,
    liveId: null,
  };
}

export type DemoAction =
  | { type: 'answer'; option: number }
  | { type: 'edit'; fieldId: string; text: string }
  | { type: 'confirm' }
  | { type: 'panel'; panel: DemoPanel }
  | { type: 'report'; open: boolean }
  | { type: 'settled' }
  | { type: 'reset' };

/** The open question card for the current phase, or null when none is waiting. */
export function openQuestion(state: DemoState): QuestionCard | null {
  if (state.phase === 'q1') return QUESTION_ONE;
  if (state.phase === 'q2') return QUESTION_TWO;
  return null;
}

/** The checklist's server-shaped data, so the real CaptureChecklist renders the demo. */
export function demoInformation(state: DemoState): Record<string, StepInformation> {
  const meta = Object.fromEntries(Object.keys(state.values).map(id =>
    [id, state.typed.includes(id) ? { source: 'user' } : { source: 'capture', basis: 'user_statement' }]));
  return {
    you: { schema: FIELDS, values: state.values, meta },
    direction: { schema: LATER.direction },
    benchmark: { schema: LATER.benchmark },
  };
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'answer': {
      const card = openQuestion(state);
      const choice = card?.options[action.option];
      if (!card || choice === undefined) return state;
      const step = state.messages.length;
      const user: DemoMessage = { id: `m${step}`, role: 'user', label: '你 · 你是谁', text: choice };
      if (state.phase === 'q1') {
        const reply = action.option === card.recommended ? REPLY_RECOMMENDED : REPLY_TRUTH;
        return { ...state, phase: 'q2', liveId: `m${step + 1}`, values: { ...state.values, experience: captured(choice) },
          messages: [...state.messages, user, { id: `m${step + 1}`, role: 'assistant', label: '导师 · 你是谁', text: reply }] };
      }
      const experience = state.values.experience?.value ?? '';
      return { ...state, phase: 'summary', liveId: `m${step + 1}`, values: { ...state.values, audience: captured(choice) },
        messages: [...state.messages, user,
          { id: `m${step + 1}`, role: 'assistant', label: '本步小结 · 你是谁', summary: true, text: summaryText(experience, choice) }] };
    }
    case 'edit': {
      const previous = state.values[action.fieldId] ?? { value: '', status: 'unknown', nature: 'unknown' };
      const value: FieldValue = { ...previous, value: action.text, status: action.text.trim() ? 'provisional' : 'unknown',
        nature: previous.nature === 'unknown' ? 'decision' : previous.nature };
      return { ...state, values: { ...state.values, [action.fieldId]: value },
        typed: state.typed.includes(action.fieldId) ? state.typed : [...state.typed, action.fieldId] };
    }
    case 'confirm': {
      const values = state.values;
      if (state.valid || FIELDS.some(field => field.required && !values[field.id]?.value.trim())) return state;
      const confirmed = Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { ...value, status: 'confirmed' as const }]));
      return { ...state, phase: 'confirmed', valid: true, values: confirmed };
    }
    case 'panel':
      return { ...state, panel: action.panel };
    case 'report':
      return { ...state, reportOpen: action.open, panel: action.open ? 'report' : state.panel === 'report' ? 'checklist' : state.panel };
    case 'settled':
      return { ...state, liveId: null };
    case 'reset':
      return initialDemoState();
  }
}
