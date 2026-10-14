/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';

/**
 * Sample J's price section, round three (Owner 2026-10-15). Prices and seat counts always come from the server; these
 * are the words around them.
 */

/**
 * NEW: the usual ways added up, shown under the four rows only when all four are on the page. Monthly: the consultant
 * range plus the scheduler and the benchmark tool ($2,000 + $45 + $82 to $10,000 + $45 + $82); once: the set-up project.
 */
export const J_PRICE_TOTAL = {
  label: '正常方案合计',
  text: '每月约 $2,127–$10,127，另加一次性约 $1,510',
  rows: ['consultant', 'project', 'scheduler', 'benchmark'],
} as const;

/**
 * The founder bar in paywall v25's form (pricing page, founderBar): shown only while seats are left. Wording per
 * MASTER_PLAN 2.1 (Owner 2026-10-14, as in #987): never "终身"; the renewal line is the shared card's own.
 */
export const J_FOUNDER_BAR = {
  title: 'Gold 创始会员 · 连续续费一直 6 折',
  rule: (price: string) => `首年 ${price}；只要连续续费，一直按 Gold 价格的 6 折，目前每年 ${price}`,
  joined: (joined: number, left: number) => `已加入 ${joined} 位 · 还剩 ${left}`,
  fresh: (total: number) => `首批开放 · 共 ${total} 个名额`,
  goldTag: '创始会员 · 连续续费一直 6 折',
  seatsLeft: (left: number) => `还剩 ${left} 个名额`,
} as const;

/** One line of a plan card: its words on Pro and on Gold; null means the plan does not include it (shown crossed out
 * with Gold's words, as v25 does). `{credits}` is replaced with the plan's monthly credits from the server. */
export type PlanFeature = { pro: string | null; gold: string; soon?: boolean; needs?: readonly LandingFeature[] };

/**
 * What Pro and Gold include, shortened from paywall v25's pricing-page cards (策略与报告 / 发布与数据 / 积分与服务), so
 * the difference between the two shows on the card. Profile counts: MASTER_PLAN 2.1 item 51 (Pro 3, Gold 6). Credits
 * come from the server catalog. "即将上线" as in v25.
 */
export const J_PLAN_FEATURES: readonly { group: string; items: readonly PlanFeature[] }[] = [
  {
    group: '策略与报告',
    items: [
      { pro: '完整运营策略报告，到期也能看、能导出', gold: '完整运营策略报告，到期也能看、能导出', needs: ['report'] },
      { pro: '3 个定位档案', gold: '6 个定位档案' },
      { pro: null, gold: '多模型专家评审团', needs: ['fusion'] },
    ],
  },
  {
    group: '发布与数据',
    items: [
      { pro: '一键发布到海外 9 个平台', gold: '一键发布到海外 9 个平台', soon: true, needs: ['publish'] },
      { pro: null, gold: '对标账号监控、90 天趋势、每周自动复盘', soon: true, needs: ['publish'] },
    ],
  },
  {
    group: '积分与服务',
    items: [
      { pro: '每月 {credits} 积分，永不过期', gold: '每月 {credits} 积分，永不过期' },
      { pro: '客服 24 小时内回复', gold: '客服工作时间内 2 小时回复' },
    ],
  },
];

/** NEW: the plan cards now lead to the pricing page instead of straight to checkout (Owner 2026-10-15). */
export const J_PLAN_LINK = {
  cta: (name: string) => `看 ${name} 完整权益并开通`,
} as const;
