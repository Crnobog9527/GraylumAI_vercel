/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * "AI 教练怎么接手你的运营", round three (Owner 2026-10-15: the clips were "过于薄弱，没有体现出 AI 教练真正的专业性").
 * The three positioning steps as the coach really works: how deep it asks, the reasons behind each judgment, the
 * risk it names, the three kinds of benchmark and the data it fetches. The demo's made-up case (a dental assistant
 * in Canada), labelled 示例; no numbers. NEW WORDING for the Owner to approve, except where marked.
 */
export type TakeoverCard = 'question' | 'confirm' | 'direction' | 'kinds' | 'fetch' | 'table';
export type TakeoverLine = { role: 'user' | 'coach' | 'risk'; text: string; card?: TakeoverCard };
export type TakeoverScene = { id: 'you' | 'direction' | 'benchmark'; title: string; note: string; lines: readonly TakeoverLine[] };

export const J_TAKEOVER_SCENES: readonly TakeoverScene[] = [
  {
    id: 'you',
    title: '你是谁',
    note: '不是让你填表。一次只问一个问题，给例子和推荐选项；你答得笼统，它就追问到具体的经历和细节。',
    lines: [
      { role: 'user', text: '我在加拿大做牙科助理，下班后和周末有点时间，想做个账号，但不知道能拍什么。' },
      {
        role: 'coach',
        text: '先不急着定拍什么。定位看四件事：你有什么别人没有的经历、能稳定投入多少时间、想帮谁、他们愿不愿意为此花钱。先问第一件：',
        card: 'question',
      },
      { role: 'user', text: '怎么在加拿大入行做牙科助理。' },
      {
        role: 'coach',
        text: '再具体一点：你自己从开始准备到拿到第一份工作，走了哪几步？哪一步最难？别人最常问你的是哪一步？',
      },
      { role: 'user', text: '读了一年带实习的课程，考了执照，投了很多简历。最难的是没有本地经验，找第一份工作。' },
      {
        role: 'coach',
        text: '"没有本地经验怎么拿到第一份工作"，正是想入行的人最卡的一步，而你刚走过。这就是你最值钱的素材。这一步齐了，请核对：',
        card: 'confirm',
      },
    ],
  },
  {
    id: 'direction',
    title: '方向判断',
    note: '它会直接说"不建议"，把理由一条条讲清，指出风险，再给推荐方向；最后由你决定。',
    lines: [
      { role: 'user', text: '我还是想主要讲日常怎么护理牙齿，这个话题看的人多。' },
      {
        role: 'coach',
        text: '我不建议把护理当主线，理由有三：\n1. 看的人多，做的人更多，牙医和诊所账号天然比你更有权威；\n2. 这类观众看完就走，很少为内容付费；\n3. 你讲不出别人讲不了的东西。',
      },
      { role: 'risk', text: '如果坚持做护理：前期涨粉可能更快，但很难变现，也容易被更专业的账号压住。' },
      { role: 'coach', text: '我的建议是主线讲你的入行经历，护理知识当补充。你来定：', card: 'direction' },
      { role: 'user', text: '那就主线讲入行经历。' },
    ],
  },
  {
    id: 'benchmark',
    title: '找对标',
    note: '对标分三类找，每类学不同的东西。数据通过接口实时抓取，是真实的公开数据；查不到的格子直接写"未取到"，不估、不编。',
    lines: [
      { role: 'coach', text: '对标分三类找，每类学的东西不一样：', card: 'kinds' },
      // OWNER (2026-10-14), verbatim.
      { role: 'coach', text: 'AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。', card: 'fetch' },
      {
        role: 'coach',
        text: '数据已经填进表格，查不到的写"未取到"。下一步我按这张表，告诉你每一类具体学什么、哪些不要学。',
        card: 'table',
      },
    ],
  },
];

/** The three kinds of benchmark and what each teaches. */
export const J_BENCHMARK_KINDS = [
  { kind: '同路人', who: '同样转行入行的人', learn: '看他们怎么讲自己的经历' },
  { kind: '同观众', who: '服务新移民的账号', learn: '看这群人爱看什么、在评论里问什么' },
  { kind: '同行业', who: '牙科从业者账号', learn: '看专业内容怎么讲得通俗' },
] as const;

/** The benchmark table: which columns the program fills. Cells show only whether a value was fetched (no numbers). */
export const J_BENCHMARK_TABLE = {
  title: '对标账号（示例）',
  columns: ['账号', '播放中位数', '互动率', '更新频率'],
  rows: [
    ['同路人 · 账号 A', '已取到', '已取到', '已取到'],
    ['同路人 · 账号 B', '已取到', '已取到', '已取到'],
    ['同观众 · 账号 C', '已取到', '未取到', '已取到'],
    ['同行业 · 账号 D', '已取到', '已取到', '已取到'],
  ],
} as const;

/** The direction card's question (the product's question card). */
export const J_DIRECTION_QUESTION = {
  question: '方向怎么定？',
  options: ['主线讲入行经历，护理知识当补充', '主线讲日常护理', '两条线各做一半'],
  recommended: 0,
  recommendationReason: '你亲身走过、别人替代不了，想入行的人也更愿意为具体的帮助付费。',
} as const;

/** Holds the jury's place until its new canvas version is merged (#998) and can play this case. */
export const J_JURY_PLACEHOLDER = '评审团演示（新版制作中）';
