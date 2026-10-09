/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Copy of the report paywall (design v25 scene 1, docs/launch/design/paywall/). Kept in one place
 * so the Owner's copy rules can be checked at a glance: no predicted credit cost, no model names,
 * no unlaunched features, no 7-day refund promise on the card, no fake original price or countdown.
 */
export const REPORT_PAYWALL_COPY = {
  eyebrow: '运营策略报告 · 草稿',
  dossierTitle: '你的运营策略报告，只差最后一步',
  dossierLede: '你确认过的信息都已保存，免费保留、可以导出。开通会员后，导师会根据这些信息为你写一份完整的运营策略报告。',
  deliverHeading: '报告直接交给你 5 样东西，拿来就能用',
  title: '生成你的完整运营策略报告',
  lede: '开通会员，导师马上把你确认的信息写成完整报告，之后每一步都可以接着问。',
  anchorConsultant: '雇佣一位社交媒体顾问',
  anchorConsultantPrice: '$2,000 – $10,000 / 月',
  anchorGraylum: '雇佣 Graylum AI 社交媒体策略师',
  anchorSourceUrl: 'https://hawksem.com/blog/social-media-consultant/',
  anchorSourceQuote: '"…a fixed monthly rate of between $2,000 and $10,000 per month."',
  cta: '生成我的完整报告',
  ctaSub: '付款后会员立即生效，回到这一页就能生成报告',
  catalogFailed: '暂时读不到会员方案，请稍后再试。你已确认的信息都保留着。',
  trust: ['随时取消', '积分永不过期', '已确认的信息免费保留'],
  later: '先不开通',
  laterNote: '已确认的信息可以用页面上的“导出已确认资料”免费下载。',
} as const;

/** [title, what it is, why it matters]; from design v25 "DELIVER". */
export const REPORT_DELIVERABLES: ReadonlyArray<readonly [string, string, string]> = [
  ['一句话定位', '你是谁、做给谁看、凭什么让人关注',
    '别再今天跟风这个、明天模仿那个：方向定下来，每条内容都在给同一批人留下印象'],
  ['账号三件套', '名称、头像、简介，复制过去就能用', '陌生人点进主页 3 秒就知道"这个号对我有用"，愿意点关注'],
  ['3–10 个对标账号', '学谁、学他哪一点，避开哪些坑', '照着已经跑通的人走，少花几个月自己试错'],
  ['第一个 30 天行动表', '每周发什么、怎么发、看哪个数据', '每天打开就知道今天发什么，不用再对着空白页发愁'],
  // The report stages monetization by entry conditions, not follower counts (positioning Skill v8 template).
  ['变现路线图', '每个阶段做什么、满足什么条件再进入下一步，一步步把流量变成收入',
    '做了半年不知道怎么赚钱的坑，提前帮你绕开：每走到一个阶段，都知道下一步怎么变现'],
];
