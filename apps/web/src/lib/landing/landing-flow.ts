/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';

/**
 * Module 3a: the nine steps after sign-up, in the order the product runs them (offer one-page, table 3a).
 * `title` and `demo` are the "动画演示" cell split at its first colon; `note` is the "为什么不是正确的废话"
 * cell. All verbatim. Every note maps to a real mechanism; a step whose capability is switched off is
 * hidden as a whole. The animations show the real screen layout with neutral placeholder lines: no
 * invented accounts, numbers or report text (those come only from demo accounts, offer brief section 12).
 */
export type FlowMock = 'chat' | 'truth' | 'research' | 'report' | 'library' | 'voice' | 'publish' | 'review' | 'fusion';

export type FlowStep = {
  id: string;
  mock: FlowMock;
  title: string;
  demo: string;
  note: string;
  needs: readonly LandingFeature[];
};

export const FLOW_NOTE_LABEL = '为什么不是正确的废话';

export const FLOW_STEPS: readonly FlowStep[] = [
  {
    id: 'step-chat', mock: 'chat', needs: ['coach'],
    title: '和教练聊',
    demo: '一次一个问题、带例子、给推荐选项，右侧笔记实时整理，每步小结、你确认',
    note: '通用 AI 等你提问，你问得笼统它就答得笼统。教练按一套固定的运营方法主动问你，问的是你的经历、资源和目标，答案是从你的情况里推出来的。',
  },
  {
    id: 'step-truth', mock: 'truth', needs: ['coach'],
    title: '教练说真话',
    demo: '方向难变现会直说，并给出调整方案',
    note: '通用 AI 顺着你说。教练的方法里有判断标准：这个方向谁会买、怎么买、你能不能做到。不够，它就说不够。',
  },
  {
    id: 'step-research', mock: 'research', needs: ['research'],
    title: '找对标',
    demo: '输入链接或关键词 → 候选分三类 → 你挑 3–5 个 → 数据由程序算出填进表格',
    note: '通用 AI 会编一个"示例账号"。这里的播放中位数、互动率、更新频率是实时查出来、程序算出来的，AI 改不了表格里的数字；查不到就写"未取到"。',
  },
  {
    id: 'step-report', mock: 'report', needs: ['report', 'research'],
    title: '出报告',
    demo: '一句话定位、账号三件套、对标拆解、第一个 30 天计划、变现路线',
    note: '报告的每一条结论，都来自前面你确认过的信息和真实对标数据，不是模板套出来的。',
  },
  {
    id: 'step-library', mock: 'library', needs: ['coach', 'library', 'voice'],
    title: '资料库，它记得你',
    demo: '新开一个窗口直接问"这周发什么"，教练带着你的定位、平台和上传过的资料来回答，不用重新介绍自己；右侧展示资料库里的定位档案、文件、文风画像',
    note: '通用 AI 每开一个新窗口，你就得从头介绍自己。教练不用：你确认过的定位、上传的资料、你的文风，都存在你的资料库里。每一次对话，它都是带着对你账号的了解来的。',
  },
  {
    id: 'step-voice', mock: 'voice', needs: ['voice', 'content'],
    title: '写内容',
    demo: '学你的文风，写出来像你本人',
    note: '它先读你写过的东西，生成文风画像，你确认后才用；不是一个腔调写给所有人。',
  },
  {
    id: 'step-publish', mock: 'publish', needs: ['publish'],
    title: '发出去',
    demo: '一键发到多个平台',
    note: '写完直接发，不用再复制到各个平台。',
  },
  {
    id: 'step-review', mock: 'review', needs: ['publish'],
    title: '看复盘',
    demo: '每周告诉你哪条有效、下周怎么调',
    note: '通用 AI 看不到你的数据。它看的是你真实发出去的内容和数据，建议是从数据里来的。',
  },
  {
    id: 'step-fusion', mock: 'fusion', needs: ['fusion'],
    title: '多模型评审团（Gold）',
    demo: '模型 A/B/C 隔离作答 → 交叉挑错 → 修订版',
    note: '一个模型有盲点。3 个以上顶级模型各自评审、互相挑错，你看到的是改过的版本和原稿的对比。',
  },
];

/** Platform names for the publish mock, as listed in FAQ 9 of the final offer. */
export const PUBLISH_PLATFORMS = [
  'TikTok', 'Instagram', 'YouTube', 'Facebook', 'X', 'Threads', 'LinkedIn', 'Pinterest', 'Bluesky',
] as const;
