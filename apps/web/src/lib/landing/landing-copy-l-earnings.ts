/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * "一个月能赚多少？算给你看" (round seven, T6, Owner 2026-10-17: "按上面这版保守数字，用三档播放量来演示……用最简单、
 * 最没有教育成本的那种方式"; supplement: "人数、订单量等这些单位的旁边，还是用括号把转化率写进去"). Under step one's
 * report (office-worker) "怎么赚钱" card: how many people are left at each step out of those who see the videos, at
 * three sizes. The figures are the plan's conservative example, copied as given; the page says it is an example.
 * Round eight (U2, Owner 2026-10-18: "这个地方的公式，你一定要把完整的销售漏斗每一层的转化结果写在这儿……然后在下面，
 * 再用直白、简单的话给用户解释"): each step's share is of the step before it; above the steps the whole formula with this
 * tier's numbers put in, below them how the five steps work, told with 10 万 plays. Still no "转化率" on the page.
 */
export const L_EARNINGS = {
  title: '一个月能赚多少？算给你看',
  switchLabel: '每月有多少人刷到你',
  tiers: ['1 万', '10 万', '50 万'],
  rows: [
    { what: '刷到你的视频', unit: '人', counts: [10_000, 100_000, 500_000], share: null, note: null },
    { what: '领了你的免费一周菜单', unit: '人', counts: [20, 200, 1_000], share: '0.2%', note: '刷到的人里，每 500 个约 1 个' },
    { what: '买了你推荐的调料、保鲜盒', unit: '单', counts: [4, 40, 200], share: '20%', note: '领过菜单的人里，每 5 个约 1 个；每单你赚约 $1.5' },
    { what: '每月 $5 订你的付费菜单', unit: '人', counts: [1, 10, 50], share: '25%', note: '买过东西的人里，每 4 个约 1 个' },
    { what: '买你的电子菜谱合集（$19）', unit: '本', counts: [0.5, 5, 25], share: '50%', note: '订菜单的人里，每 2 个约 1 个' },
  ],
  totalLabel: '这个月大约能赚',
  totals: [20, 200, 1_000],
  yearly: [null, null, '一年约 $12,000'],
  formula: {
    title: '每个月能赚多少，这样算',
    general: '每月收入 = 每月播放量 × 领菜单率（第 2 层）×（买货率（第 3 层）× 每单佣金 ＋ 买货率 × 订阅率（第 4 层）× 订阅价 '
      + '＋ 买货率 × 订阅率 × 买书率（第 5 层）× 书价）',
    /** This tier's numbers put in: plays, then people who took the menu, then the month (the plan's arithmetic). */
    plays: ['10,000', '100,000', '500,000'],
    menus: ['20', '200', '1,000'],
    results: ['$20', '$205', '$1,025'],
    rates: '20% × $1.5 ＋ 20% × 25% × $5 ＋ 20% × 25% × 50% × $19',
    perPerson: '$0.30 ＋ $0.25 ＋ $0.475',
    plain: '换句话说：每 1,000 次播放，大约能赚 $2。播放量翻倍，收入跟着翻倍；任何一层的比例提高一点，收入也跟着涨。',
  },
  layers: {
    title: '10 万次播放，是怎么一层层变成愿意付钱的人的',
    items: [
      { name: '免费内容（10 万次播放）', text: '大多数人只是刷过。这一层的任务是让真正想自己做饭的人停下来，记住你"15 分钟上桌"。' },
      { name: '免费一周菜单（200 人）', text: '只有真打算做饭的人，才会留联系方式领菜单。这是第一次把"刷过的人"变成你能联系上的人。' },
      { name: '带货（40 单）', text: '照着菜单做过的人，会顺手买你用的调料、保鲜盒。花小钱，说明他开始信你。' },
      { name: '付费菜单（10 人）', text: '买过、觉得省事的人，愿意每月 $5 让你帮他安排吃什么。这是第一笔稳定收入。' },
      { name: '电子菜谱合集（5 本）', text: '一路跟下来的人最信你，愿意买 $19 的合集。' },
    ],
    close: '越往下人越少，但越信你、付的钱越多。收入高低看两件事：播放量有多大，每一层留下多少人。AI 教练每周帮你看哪一层漏得最多，先补那一层。',
  },
  disclaimer: '示例推算，按保守比例估计，不代表你的结果。',
} as const;

/** A count as the page writes it: half of one is "0–1". */
export const earningCount = (count: number) => (count > 0 && count < 1 ? '0–1' : Math.round(count).toLocaleString('en-US'));
export const earningTotal = (amount: number) => `约 $${Math.round(amount).toLocaleString('en-US')}`;
