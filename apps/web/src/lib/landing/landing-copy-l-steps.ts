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
      // Owner 2026-10-18 (edit mode): sample L's own note; sample J keeps its own.
      { label: '生成完整运营策略报告', moment: 3, note: '三步都确认后，AI 教练将根据你的信息生成定制化的策略分析报告。', needs: ['report'] },
    ] as readonly StepStage[],
  },
} as const;

/** The jury, larger (Owner 2026-10-17: "把这个按钮和模块稍微做大一点"); wording from the plan, true to the mechanism. */
export const L_JURY = {
  name: '多模型评审团',
  tier: 'Gold 专属',
  /**
   * Round twelve (Owner 2026-10-18: "把模块 4 评审团的介绍，拼接到模块 3 第一步'完整策略报告'的下方……评审端的功能也要讲
   * 清楚，不要省略得太多"): the jury hangs under step one's window, a circuit line running from its "生成完整报告" into
   * the jury's "你的报告". Plain words, true to the jury (FUSION-REVIEW): no model brands, no credits, no "再辩一轮",
   * "最多两轮" or "辩到没有分歧为止". The third point follows the real result page (each changed chapter shows its
   * sentences before and after, and why the chapter changed), not "every change beside the original".
   */
  bridge: '报告写完了，还可以再加一道关',
  title: '交给 3 个顶级大模型，再帮你挑一遍错',
  points: [
    { lead: '各自独立读完你的报告', text: '三个模型分别站在你的受众和你本人的角度，挑出说不通、说过头、和你情况对不上的地方。' },
    { lead: '看法不一样的地方，交叉审一遍', text: '一个模型觉得有问题、另一个觉得没问题的地方，会互相交叉审一遍，把分歧说清楚。' },
    { lead: '主笔合成一份修订稿', text: '把意见汇总成修订稿，每一章标出改前、改后的句子，并写明这一章为什么改。' },
    { lead: '每一章由你决定', text: '采用评审团的修订，还是保留原来的方向，一章一章选；原报告一直留着。' },
  ],
  example: {
    tag: '示例',
    where: '第 3 章 受众',
    note: '你写的是"刚开始一个人住的上班族"，但没说清是华人还是非华人。开头用中文口播，可能挡掉一半人；建议前两周中英字幕两种都测。',
    result: '你选了"采用修订"',
  },
  whenLabel: '什么时候值得用',
  when: '准备照着报告投入时间和钱之前，比如辞职全职做、花钱投流、开课收费前，先让评审团把一遍关。',
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
    debate: '看法不一样的地方，交叉审一遍，把分歧说清楚',
    lead: '主笔汇总成修订稿',
    decide: '每一章由你决定：采用评审团的修订，还是保留原来的方向。',
    decideTitle: '你来决定',
    chapters: ['3 受众', '5 对标账号分析', '9 运营手册'],
    adopt: '采用修订',
    keep: '保留原文',
  },
  needs: ['fusion'] as readonly LandingFeature[],
} as const;

/** Region 6, one scenario at a time (Owner 2026-10-17): its tab, title and one line saying the point. NEW. */
export const L_SCENARIOS = {
  label: '选一个场景',
  /** Not a product window: a marketing comparison. */
  badge: '示意',
  /** By the task's index in L_TASKS. */
  items: [
    { tab: '加做小红书', title: '同样问「小红书也想做起来，该怎么弄」', lede: '一个给你一套通用做法，一个按你已有的 TikTok 数据，告诉你哪些不用变、哪些要改。' },
    { tab: '这周拍什么', title: '同样问「这周拍什么」', lede: '一个给你一张谁都能拍的清单，一个按你的定位和对标数据，挑出这周最值得拍的三条。' },
    { tab: '写稿', title: '同样说「帮我写一条口播稿」', lede: '一个给你一套通用模板，一个按你的定位和说话习惯，写出你自己的稿子和分镜。' },
    { tab: '这条为什么没火', title: '同样问「这条为什么没火」', lede: '一个列出所有可能的原因，一个读了你自己的数据，告诉你问题在哪、下周怎么改。' },
  ],
  /** How long each scenario stays before the next (milliseconds), after its typing ends. */
  holdMs: 3500,
} as const;
