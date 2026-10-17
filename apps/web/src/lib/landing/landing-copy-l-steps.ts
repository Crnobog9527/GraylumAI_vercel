/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { J_TAKEOVER_MOMENTS } from './landing-copy-j-takeover';
import type { LandingFeature } from './landing-flags';

/**
 * Sample L, round four (Owner 2026-10-17). Region 3 in three steps headed 第一步/第二步/第三步: step one is sample J's
 * whole positioning flow on the real product's parts (its four stages under the product's own step names, each with
 * sample J's note, no "为什么不是正确的废话" lead-in); steps two and three (content each week; the data loop, "数据飞轮"
 * being the Owner's title) are in landing-copy-l-later.ts (round five). Then the jury,
 * larger, and region 6 one scenario at a time. NEW lines are marked.
 */
export type StepStage = { label: string; moment: number; note: string; needs?: readonly LandingFeature[] };

export const L_STEPS = {
  /** NEW: shown with the progress bar, the share of the step already seen. */
  progress: '第一步进度',
  /** NEW: for a visitor who has watched it before (remembered in this browser). */
  skip: '看过了，跳过这段',
  one: {
    title: '第一步：先把你的定位挖清楚',
    stages: [
      { label: '了解你', moment: 0, note: J_TAKEOVER_MOMENTS[0].note },
      { label: '诊断与平台对标', moment: 1, note: J_TAKEOVER_MOMENTS[1].note, needs: ['research'] },
      { label: '定位与执行方案', moment: 2, note: J_TAKEOVER_MOMENTS[2].note },
      { label: '生成完整运营策略报告', moment: 3, note: J_TAKEOVER_MOMENTS[3].note, needs: ['report'] },
    ] as readonly StepStage[],
  },
} as const;

/** The jury, larger (Owner 2026-10-17: "把这个按钮和模块稍微做大一点"); wording from the plan, true to the mechanism. */
export const L_JURY = {
  name: '多模型评审团',
  tier: 'Gold 专属',
  title: '你的报告，交给 3 个顶级大模型一起审。',
  flow: ['站在你的受众和你本人的角度，各自独立挑错', '意见不一致就再辩一轮', '汇总成一份修订稿，每一章用不用由你决定。'],
  link: '看评审团怎么工作',
  href: '/landing/preview/jury',
  /**
   * NEW (round six, S10: "让用户通过这个可视化的动画，大概能了解到什么叫做评审团"): the flow beside the card, as the jury
   * works (FUSION-REVIEW): the report in; three reviewers find faults on their own; only where they disagree, one more
   * round (two rounds at most); the lead writer puts it together; each chapter, revision or original, is yours to pick.
   */
  anim: {
    label: '评审团怎么工作',
    report: '你的报告',
    reviewers: ['模型 A', '模型 B', '模型 C'],
    review: '各自挑错',
    debate: '意见不一致的地方，再辩一轮',
    debateNote: '最多两轮',
    lead: '主笔汇总成修订稿',
    chapters: ['3 受众', '5 对标账号分析', '9 运营手册'],
    adopt: '采用修订',
    keep: '保留原文',
  },
  needs: ['fusion'] as readonly LandingFeature[],
} as const;

/** Region 6, one scenario at a time (Owner 2026-10-17): its tab, title and one line saying the point. NEW. */
export const L_SCENARIOS = {
  label: '选一个场景',
  pause: '暂停',
  play: '继续播放',
  /** Not a product window: a marketing comparison. */
  badge: '示意',
  /** By the task's index in L_TASKS. */
  items: [
    { tab: '定位', title: '同样问「该怎么定位」', lede: '一个给你一套框架让你自己套，一个先把你的情况问清楚，再下判断。' },
    { tab: '这周拍什么', title: '同样问「这周拍什么」', lede: '一个给你一张谁都能拍的清单，一个按你的定位和对标数据，挑出这周最值得拍的三条。' },
    { tab: '写稿', title: '同样说「帮我写一条口播稿」', lede: '一个给你一套通用模板，一个按你的定位和说话习惯，写出你自己的稿子和分镜。' },
    { tab: '这条为什么没火', title: '同样问「这条为什么没火」', lede: '一个列出所有可能的原因，一个读了你自己的数据，告诉你问题在哪、下周怎么改。' },
  ],
  /** How long each scenario stays before the next (milliseconds), after its typing ends. */
  holdMs: 3500,
} as const;
