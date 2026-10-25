/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import type { REPORT_DELIVERABLES } from './reportPaywallCopy';

/**
 * Copy of the Gold-only paywalls (Owner 2026-10-25: a member-only entry opens the paywall on the current page). Same rules as the
 * report paywall copy: no predicted credit cost, no model names, no unlaunched features, no refund promise on the card.
 * Only the Gold plans are offered here, so a Pro purchase can never leave the user without the feature they came for.
 */
export type GoldScene = 'compare' | 'jury';

export const GOLD_SCENE_COPY = {
  compare: {
    eyebrow: '多模型对比 · Gold 专享',
    dossierTitle: '同一个问题，让几个 AI 同时回答，你来挑',
    dossierLede: '多模型对比是 Gold 会员功能。你写好的内容不会丢，开通后回到这里就能直接对比。',
    deliverHeading: '开通后你可以',
    title: '开通 Gold，使用多模型对比',
    lede: '开通 Gold 会员，同一个问题交给几个 AI 同时回答，并排看清差别，再选你最想要的那个继续。',
    cta: '开通 Gold，使用多模型对比',
    ctaSub: '付款后会员立即生效，回到这一页就能开始对比',
    laterNote: '你写的内容还在，关闭后可以继续使用。',
  },
  jury: {
    eyebrow: '评审团 · Gold 专享',
    dossierTitle: '让评审团帮你把报告再审一遍',
    dossierLede: '评审团是 Gold 会员功能。你的报告和已确认的信息都保留着，开通后回到这里就能请评审团审阅。',
    deliverHeading: '开通后你可以',
    title: '开通 Gold，请评审团审阅报告',
    lede: '开通 Gold 会员，几位评审从不同角度审阅你的报告，逐章给出意见，由你决定采用哪些。',
    cta: '开通 Gold，请评审团审阅',
    ctaSub: '付款后会员立即生效，回到这一页就能请评审团审阅',
    laterNote: '你的报告和已确认的信息都保留着。',
  },
} as const;

export const GOLD_SCENE_DELIVERABLES: Record<GoldScene, typeof REPORT_DELIVERABLES> = {
  compare: [
    ['并排看几个回答', '同一个问题，几个 AI 各答一份，同时逐字出现', '不用来回切换，一眼看出谁更对你的路子'],
    ['挑一个继续', '喜欢哪一份，一键用它接着聊', '选定的回答会写进当前对话，后面的追问都接得上'],
    ['不满意就停', '随时可以全部停止或只停一列', '没开始的部分不收费，已经写出来的按实际用量计费'],
  ],
  jury: [
    ['多位评审同时审阅', '从不同角度审阅同一份报告', '一个人想不到的问题，几位评审更容易发现'],
    ['逐章给意见', '每一章都有评审意见，清楚标出问题在哪', '知道改哪里，而不是只得到一句笼统的评价'],
    ['由你决定怎么改', '逐章选择采用哪条意见', '你的判断优先，评审只负责提醒'],
  ],
};
