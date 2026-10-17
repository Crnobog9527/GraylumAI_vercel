/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * NEW (Owner 2026-10-17): sample L's region 4, the sample reports, redone from the visitor's side. The people in the
 * reports are fictional, so they are never called 用户案例; each card and the dialog carry one small grey 「示例」 tag
 * instead of the long "由 Graylum 定位 Skill 生成，人物为虚构" line. The coach's warning is 「方向已调整」 on a card and
 * 「风险提醒」 in the dialog. Samples M, N and O keep L_SAMPLES (landing-copy-l.ts).
 */
export const L_SAMPLES_REDO = {
  /** NEW */
  title: '找到和你情况一样的人',
  /** NEW: under the title; the count and its measure word never part (the gap before the count is drawn). */
  ledeParts: (count: number) => ['这里有', `${count} 种人`, '拿到的完整报告，点开任意一张看'] as const,
  lede: (count: number) => `这里有 ${count} 种人拿到的完整报告，点开任意一张看`,
  /** NEW: one small grey tag on every card and in the dialog. */
  sample: '示例',
  /** NEW: the card's tag when the coach changed the person's direction. */
  adjusted: '方向已调整',
  open: '看这份报告',
  /** NEW (round six): the secondary entry to the whole report under the overview. */
  fullReport: '看完整报告',
  close: '关闭',
  /** NEW (round five): the dialog's 15-second overview, its blocks' headings. */
  overview: {
    title: '15 秒看懂这份报告',
    /** NEW (round six, S11): the top blocks, in the same cards as the rest. */
    person: '这份报告写给谁',
    position: '一句话定位',
    /** NEW (round six, S12): the account card; its name and bio are the report's recommended ones. */
    accountTag: '按报告建议改好后的样子 · 示意',
    accountFollowers: '粉丝',
    accountPosts: '作品',
    accountTop: '最好的一条',
    noAccount: '还没有账号，从这里开始',
    /** NEW (round six, S13): plain-language help for the content mix and the funnel (sent to the offer window to review). */
    pillarsLede: '每发 10 条内容，大概按这个比例分：',
    pillarHelp: [
      { key: '流量', what: '让没见过你的人刷到你、停下来看', example: '例：一看就懂、值得收藏的实用内容' },
      { key: '信任', what: '让刷到的人相信你懂行、愿意关注你', example: '例：讲清为什么这么做，分享你的真实经历' },
      { key: '转化', what: '让信任你的人愿意掏钱', example: '例：介绍你的产品、服务，或你真在用的东西' },
    ] as const,
    funnelLede: '从上往下，人越来越少、关系越来越近：上面几层让人认识你、信你，下面几层才让人付钱。',
    sketch: '示意',
    risk: '风险提醒',
    audience: '给谁看',
    platform: '在哪发',
    support: '同步',
    benchmarks: '对标账号',
    benchmark: (id: string) => `对标账号 ${id}`,
    followers: '粉丝',
    medianViews: '播放中位数',
    engagementRate: '互动',
    updateFreq: '更新',
    learn: '学它',
    differentiation: '你和别人不一样在哪',
    threePiece: '账号三件套',
    pillars: '内容怎么配',
    funnel: '怎么赚钱',
    plan30: '前 30 天',
    week: (n: number) => `第 ${n} 周`,
    metrics: '每周看这几个数',
    first: '这周第一步',
  },
} as const;
