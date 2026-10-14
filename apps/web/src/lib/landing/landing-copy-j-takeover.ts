/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { J_PERSONA, J_PERSONA_KINDS } from './landing-copy-j-persona';

/**
 * "AI 教练怎么接手你的运营", round four (Owner 2026-10-15): the real product's positioning workspace for the page's
 * example person (J_PERSONA). The product's own steps (你是谁 → 方向判断 → 找对标) appear once, in the workbench's step
 * strip; then the report is generated from the workbench footer, and the jury is opened from the report. What the
 * current moment shows is said outside the window (`caption`, `note`). On the landing page the first step is called
 * "帮你挖掘定位"; the product keeps "你是谁". NEW WORDING for the Owner to approve, except where marked.
 */
export type TakeoverCard = 'question' | 'confirm' | 'direction' | 'kinds' | 'fetch' | 'table' | 'report';
export type TakeoverLine = { role: 'user' | 'coach' | 'risk'; text: string; card?: TakeoverCard };
export type TakeoverMoment = {
  id: 'you' | 'direction' | 'benchmark' | 'report' | 'jury';
  /** Which product step the strip shows as current; 3 means all three are done (report and jury). */
  step: 0 | 1 | 2 | 3;
  caption: string;
  note: string;
  lines: readonly TakeoverLine[];
};

export const J_TAKEOVER_MOMENTS: readonly TakeoverMoment[] = [
  {
    id: 'you', step: 0, caption: '帮你挖掘定位',
    note: '一次只问一个问题，给例子和推荐选项；你答得笼统，就追问到具体的时间、顾虑和细节，再把你没想到的补上。',
    lines: [
      { role: 'user', text: '我想做个做饭账号，拍下班后的家常菜。' },
      {
        role: 'coach', card: 'question',
        text: '先不急着定拍什么。定位看四件事：你有什么别人没有的、能稳定投入多少时间、想帮谁、他们愿不愿意为此花钱。先问第一件：',
      },
      { role: 'user', text: '做得特别快。' },
      { role: 'coach', text: '具体有多快？下班后留给做饭和拍摄的时间有多少？对出镜有没有顾虑？' },
      { role: 'user', text: '大多数菜 15 分钟能做完，下班后只有一小时。不太想露脸。' },
      {
        role: 'coach', card: 'confirm',
        text: '"下班后 15 分钟上桌"就是你的卖点，不露脸只拍手和锅也够。我补一件你没提的：拍摄会让做饭时间翻倍，所以先按每周两条来排。这一步齐了，请核对：',
      },
    ],
  },
  {
    id: 'direction', step: 1, caption: '方向判断',
    note: '直接说"不建议"，把理由一条条讲清，单独提示风险，再给推荐方向；最后由你决定。',
    lines: [
      { role: 'user', text: '我其实更想拍周末的精致大餐，看起来更高级。' },
      {
        role: 'coach',
        text: '我不建议把精致大餐当主线，理由有三：\n1. 做的人多，不少是专业团队，拍得比你精；\n2. 一条要大半天，下班后的一小时做不完；\n3. 观众爱收藏，但很少真的照着做。',
      },
      { role: 'risk', text: '如果坚持做精致大餐：单条耗时长，下班后很难稳定更新，容易断更。' },
      { role: 'coach', card: 'direction', text: '我的建议是主线做下班后 15 分钟家常菜，精致大餐留到节日偶尔做。你来定：' },
      { role: 'user', text: '那就主线做 15 分钟家常菜。' },
    ],
  },
  {
    id: 'benchmark', step: 2, caption: '找对标',
    note: '对标分三类找，每类学不同的东西。数据通过接口实时抓取，是真实的公开数据；查不到的格子直接写"未取到"，不估、不编。',
    lines: [
      { role: 'coach', card: 'kinds', text: '对标分三类找，每类学的东西不一样：' },
      // OWNER (2026-10-14), verbatim.
      { role: 'coach', card: 'fetch', text: 'AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。' },
      { role: 'coach', card: 'table', text: '数据已经填进表格，查不到的写"未取到"。下一步我按这张表，告诉你每一类具体学什么、哪些不要学。' },
    ],
  },
  {
    id: 'report', step: 3, caption: '生成完整报告',
    note: '三步都确认后，在工作台底部生成完整运营策略报告：根据你确认过的全部信息来写，边写边显示。',
    lines: [{ role: 'coach', card: 'report', text: '三步都确认了，可以生成完整报告。' }],
  },
  {
    id: 'jury', step: 3, caption: '报告生成 → 开启评审团（Gold）',
    note: '报告写好后，Gold 会员可以在报告里开启评审团：几位评审各自审一遍，有分歧的地方辩论，再裁决并写出修订稿。',
    lines: [],
  },
];

/** The benchmark table: which columns the program fills. Cells show only whether a value was fetched (no numbers). */
export const J_BENCHMARK_TABLE = {
  title: '对标账号（示例）',
  columns: ['账号', '播放中位数', '互动率', '更新频率'],
  rows: [
    ['同路人 · 账号 A', '已取到', '已取到', '已取到'],
    ['同路人 · 账号 B', '已取到', '已取到', '已取到'],
    ['同观众 · 账号 C', '已取到', '未取到', '已取到'],
    ['同品类 · 账号 D', '已取到', '已取到', '已取到'],
  ],
} as const;

/** The report as the product shows it (title, intro and button: report-gen.ts, verbatim) with this person's content. */
export const J_REPORT = {
  title: '完整运营策略报告',
  intro: '所有步骤都已确认。导师会根据你确认的全部信息写一份完整报告，边写边显示。',
  generate: '生成完整报告',
  sections: [
    { title: '一句话定位', body: J_PERSONA.values.direction },
    { title: '账号三件套', body: `名字：${J_PERSONA.account}；简介：一个人也好好吃饭，下班后 15 分钟上桌；只拍手和锅，不露脸。` },
    { title: '对标拆解', body: J_PERSONA_KINDS.map(item => `${item.kind}：${item.learn}`).join('；') },
    { title: '第一个月计划', body: '先每周两条：一口锅两菜一汤、冰箱剩菜三种做法、超市半成品怎么做得像现做。' },
    { title: '变现路线', body: '先做厨具和食材的带货清单，再出一周菜单和备菜指南，之后整理成一人食菜谱合集。' },
  ],
  juryEntry: '开启评审团',
  juryTag: 'Gold',
} as const;

/** NEW: holds the jury's place until its canvas version is merged (#1002) and can play here. */
export const J_JURY_PLACEHOLDER = '评审团演示（新版制作中）';
