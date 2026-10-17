/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { QuestionCard } from '@repo/api/src/shared/agentTurn';

/**
 * Sample J's one example person (Owner 2026-10-15: "选一个贴近生活的……受众比较广的那种"): an office worker with one
 * hour after work who can cook twenty-odd home dishes and wants a side account, "下班后 15 分钟家常菜". The same person
 * as the jury prototype's report. Every demo on the page uses these. NEW WORDING for the Owner to approve; made up,
 * labelled 示例 where shown, no data figures (the 15 minutes and one hour are the person's own situation).
 */
export const J_PERSONA = {
  /** Shown as the account in windows. */
  account: '下班后 15 分钟家常菜',
  /** The checklist's values once each positioning step is confirmed (the product's own field ids). */
  values: {
    experience: '会做二十多道家常菜，多数 15 分钟能上桌',
    time: '每天下班后一小时',
    audience: '刚开始一个人生活的上班族',
    direction: '下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族',
    risk: '周末精致大餐耗时长，下班后难以稳定更新',
    accounts: '同路人、同观众、同品类三类',
  },
} as const;

/**
 * The question cards of the real conversation (transcript.md T1-2, T1-10; round seven, Owner 2026-10-15): short labels
 * only, the question's examples stay in the coach's message (Skill rule). The goal card replaces the old
 * "身边的人最常夸你哪一点" card, which the real conversation does not use at this point.
 */
export const J_PERSONA_GOAL = {
  question: '你最想从账号得到什么？',
  options: ['记录生活', '副业收入', '做成主业', '还没想好'],
  recommended: 1,
  recommendationReason: '你说"拍下班后的家常菜"，本身就是每天要做的事，最容易长期坚持的是"顺手赚点钱"这条路。',
} as unknown as QuestionCard;

export const J_PERSONA_ON_CAMERA = {
  question: '出镜方式？',
  options: ['露脸', '只拍手和锅', '只拍手、不出声'],
  recommended: 1,
  recommendationReason: '做饭视频大家看的是锅里，只拍手和锅完全够用，还更省事。',
} as unknown as QuestionCard;

/** 方向判断: the direction card. */
export const J_PERSONA_DIRECTION = {
  question: '方向怎么定？',
  options: ['主线做下班后 15 分钟家常菜', '主线做周末精致大餐', '两样各做一半'],
  recommended: 0,
  recommendationReason: '你每天都做得到、别人照着也学得会，想省时间的上班族最需要这类内容。',
} as unknown as QuestionCard;

/** 找对标: the three kinds of benchmark and what each teaches. */
export const J_PERSONA_KINDS = [
  { kind: '同路人', who: '同样下班后做饭的上班族账号', learn: '看怎么把"省时间"讲得有说服力' },
  { kind: '同观众', who: '一人食、一人份做饭类账号', learn: '看这群人关心什么、在评论里问什么' },
  { kind: '同品类', who: '快手菜、中式家常菜账号', learn: '看怎么把步骤拍清楚、讲简单' },
] as const;

/**
 * The real product's positioning steps and checklist fields, as the positioning Skill (v13) declares them: every field
 * is required (round seven, 2026-10-15, checked against the Skill's workflow; it replaces the test fixture's fields).
 * The landing page calls step one "帮你挖掘定位" in its own captions; inside the product window the step keeps its name.
 */
export const J_STEPS = [
  { id: 's1', title: '了解你' },
  { id: 's2', title: '诊断与平台对标' },
  { id: 's3', title: '定位与执行方案' },
] as const;
export type JStepId = (typeof J_STEPS)[number]['id'];

type JField = { id: string; title: string; required: boolean; elicitation?: 'user_fact' | 'agent_proposal' };
const field = (id: string, title: string, elicitation: JField['elicitation']): JField => ({ id, title, required: true, elicitation });
export const J_FIELDS: Record<JStepId, readonly JField[]> = {
  s1: [
    field('goal', '最终想得到什么（目标与变现方式）', 'agent_proposal'),
    field('track', '赛道与内容', 'user_fact'),
    field('audience', '想吸引的人', 'user_fact'),
    field('platforms', '想做的平台', 'user_fact'),
    field('benchmarks', '对标账号（名称和主页地址，或没有）', 'user_fact'),
    field('resources', '能投入的时间、精力、预算和限制', 'user_fact'),
    field('assets', '手上已有的条件', 'user_fact'),
  ],
  s2: [
    field('feasibility', '变现可行性判断', 'agent_proposal'),
    field('platform_choice', '平台建议', 'agent_proposal'),
    field('benchmark_findings', '对标结论', 'agent_proposal'),
  ],
  s3: [
    field('positioning', '一句话定位与差异化', 'agent_proposal'),
    field('profile_kit', '账号三件套（名称、头像、简介）', 'agent_proposal'),
    field('first_month', '第一个 30 天计划', 'agent_proposal'),
    field('offer', '变现路径', 'agent_proposal'),
  ],
};

/**
 * This person's values, field by field, from the real conversation's step summaries; `proposal` marks what the coach
 * proposed ("草稿 · 导师建议"), the rest is what the person said ("草稿 · 从对话记下").
 */
export const J_FIELD_VALUES: Record<string, { value: string; proposal: boolean }> = {
  goal: { value: '做副业，不辞职；一年后希望每月多几百美元，起步先走厨具和食材带货', proposal: true },
  track: { value: '中式家常菜，二十多道，多数 15 分钟上桌', proposal: false },
  audience: { value: '刚开始一个人住的上班族：下班晚、累、外卖贵、一人份食材吃不完', proposal: false },
  platforms: { value: '常刷 TikTok、Instagram；不做需要另剪的长视频', proposal: false },
  benchmarks: { value: '没有，由 AI 教练找', proposal: false },
  resources: { value: '工作日每晚约 1 小时，周末不固定；不露脸，可出声；手机 + 橱柜支架', proposal: false },
  assets: { value: '做得快；朋友常问做法', proposal: false },
  feasibility: { value: '可行但难：难在赛道挤、带货要信任；用"一人份 + 15 分钟 + 中式家常"收窄', proposal: true },
  platform_choice: { value: 'TikTok 主平台，Instagram Reels 同步发；YouTube 只放 Shorts 和用旧视频拼的"一周晚饭合集"，不另拍', proposal: true },
  benchmark_findings: {
    value: '5 个合格对标（同路人 1、同观众 2、同品类 2）；可学：先给成品再讲步骤、标题写时间、一人份不剩菜、固定系列名', proposal: true,
  },
  positioning: {
    value: '下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族；差异化：本人就是目标人群，"15 分钟"每条可验证，中式家常 × 一人份 × 下班',
    proposal: true,
  },
  profile_kit: { value: '名字：下班后 15 分钟家常菜；简介：一个人也好好吃饭｜下班后 15 分钟上桌；头像：一口锅的特写', proposal: true },
  first_month: {
    value: '每周两条（周二、周四下班后）：一口锅系列、冰箱剩菜、超市半成品改造轮着来；只拍手和锅，先给成品；每周看一次数据（默认周日，手机上二十分钟）再调下周选题',
    proposal: true,
  },
  offer: { value: '先做厨具和食材带货清单，再出一周菜单和备菜指南，之后整理成一人食菜谱合集', proposal: true },
};
