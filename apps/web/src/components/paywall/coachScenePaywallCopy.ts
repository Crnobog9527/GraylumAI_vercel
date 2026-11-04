/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import type { REPORT_DELIVERABLES } from './reportPaywallCopy';

/**
 * Copy of the review-coach paywall (Owner 2026-11-04: a member-only Skill is shown to everyone and a free user who tries to use it meets
 * the paywall). Unlike the Gold-only scenes it offers Pro and Gold, because the coach is for both. Same rules as the other paywall
 * copy: no predicted credit cost, no model names, no unlaunched features, no refund promise on the card.
 */
export const COACH_SCENE_COPY = {
  eyebrow: '运营复盘教练 · Pro 和 Gold 专享',
  dossierTitle: '让教练帮你复盘每一条作品',
  dossierLede: '运营复盘教练是 Pro 和 Gold 会员功能。开通后回到这里，说一句“帮我复盘”就能开始。',
  deliverHeading: '开通后你可以',
  title: '开通会员，使用运营复盘教练',
  lede: '开通 Pro 或 Gold 会员，教练会根据你的作品数据，告诉你卡在哪一步、下周先改什么。',
  cta: '开通会员，使用复盘教练',
  ctaSub: '付款后会员立即生效，回到这里说一句“帮我复盘”就能开始',
  laterNote: '你写的内容都还在，关闭后可以继续使用。',
} as const;

export const COACH_SCENE_DELIVERABLES: typeof REPORT_DELIVERABLES = [
  ['看清卡在哪一步', '被推荐、点开、看下去、互动、关注，逐层对照行业参考线', '不靠感觉，知道问题出在开头、内容还是别的地方'],
  ['发后台截图也能读', '把数据后台的截图发给教练，它读出数字请你核对', '读到的数字会记下来，下次周复盘直接用'],
  ['每周一页复盘', '每周写一页：本期表现、有效内容、下一步建议', '建议是你这周能做的具体事，不是口号'],
];
