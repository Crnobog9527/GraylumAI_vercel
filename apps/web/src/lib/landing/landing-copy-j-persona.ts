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

/** "帮你挖掘定位" (the product step is 你是谁): the coach's first question, the product's question card. */
export const J_PERSONA_QUESTION = {
  question: '你做饭时，身边的人最常夸你哪一点？',
  options: ['味道像家里的', '做得特别快', '用料省钱'],
  recommended: 1,
  recommendationReason: '快是下班族最缺的，也是你每天都能拍出来证明的东西。',
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
  { kind: '同观众', who: '一人食、租房生活类账号', learn: '看这群人关心什么、在评论里问什么' },
  { kind: '同品类', who: '快手菜、家常菜账号', learn: '看怎么把步骤拍清楚、讲简单' },
] as const;
