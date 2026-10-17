/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * "一个月能赚多少？算给你看" (round seven, T6, Owner 2026-10-17: "按上面这版保守数字，用三档播放量来演示……用最简单、
 * 最没有教育成本的那种方式"; supplement: "人数、订单量等这些单位的旁边，还是用括号把转化率写进去"). Under step one's
 * report (office-worker) "怎么赚钱" card: how many people are left at each step out of those who see the videos, at
 * three sizes. The figures are the plan's conservative example, copied as given; the page says it is an example.
 * No "转化率", "漏斗" or "层" on the page: the percentage alone, and "每 N 个人里约 1 个".
 */
export const L_EARNINGS = {
  title: '一个月能赚多少？算给你看',
  switchLabel: '每月有多少人刷到你',
  tiers: ['1 万', '10 万', '50 万'],
  rows: [
    { what: '刷到你的视频', unit: '人', counts: [10_000, 100_000, 500_000], share: null, note: null },
    { what: '领了你的免费一周菜单', unit: '人', counts: [20, 200, 1_000], share: '0.2%', note: '每 500 个刷到的人里约 1 个' },
    { what: '买了你推荐的调料、保鲜盒', unit: '单', counts: [4, 40, 200], share: '0.04%', note: '每 2,500 个刷到的人里约 1 单，每单你赚约 $1.5' },
    { what: '每月 $5 订你的付费菜单', unit: '人', counts: [1, 10, 50], share: '5%', note: '领过免费菜单的人里，每 20 个约 1 个' },
    { what: '买你的电子菜谱合集（$19）', unit: '本', counts: [0.5, 5, 25], share: '50%', note: '订菜单的人里，每 2 个约 1 个' },
  ],
  totalLabel: '这个月大约能赚',
  totals: [20, 200, 1_000],
  yearly: [null, null, '一年约 $12,000'],
  summary: '钱 = 刷到你的人 × 每一步留下来的人。刚开始一个月 1 万人刷到，基本赚不到钱，前两个月先攒信任；'
    + 'AI 教练每周帮你看哪一步留下的人最少，先补那一步。',
  disclaimer: '示例推算，按保守比例估计，不代表你的结果。',
} as const;

/** A count as the page writes it: half of one is "0–1". */
export const earningCount = (count: number) => (count > 0 && count < 1 ? '0–1' : Math.round(count).toLocaleString('en-US'));
export const earningTotal = (amount: number) => `约 $${Math.round(amount).toLocaleString('en-US')}`;
