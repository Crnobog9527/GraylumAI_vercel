/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Wording that only style sample J uses (PUBLIC-SITE, Owner 2026-10-14). Everything marked NEW is a draft for the
 * Owner to approve (it is listed in the copy-change list handed over with the sample); OWNER is the Owner's own
 * wording, verbatim. The shared landing copy stays in landing-copy.ts.
 */

/** NEW: one heading per voice-wall answer, matching the pain on the left (replaces the shared "教练怎么做"). */
export const J_NOTE_HEADS: Readonly<Record<string, string>> = {
  p7: '用专业运营的眼光替你把关方向',
  p1: '随时问随时答，答的是你自己的账号',
  p2: '每一步都具体到能直接照做',
  p3: '从你的日常里挖出能拍的方向',
  p4: '用真实数据找出差距，告诉你怎么改',
  p5: '课上完了，还有 AI 教练一直带着你',
  p8: '每周发什么，提前替你排好',
};

/**
 * NEW (Owner 2026-10-15): the answers under each note, sample J only. Say "我们的 AI 教练", never "它"; the heading
 * leads with the result, the answer says in the simplest words how the AI coach does it.
 */
export const J_NOTE_ANSWERS: Readonly<Record<string, string>> = {
  p7: '我们的 AI 教练不急着给你一堆内容，而是先按专业运营的方法把方向定清楚，再看真实数据判断能不能做。方向难赚钱会直接告诉你，并给出调整方案。',
  p1: '我们的 AI 教练 24 小时在线，记得你确认过的定位，也读过你上传的资料。所以回答的是你这个账号的具体问题，不是群发的攻略。',
  p2: '我们的 AI 教练每一步只讲三件事：现在做什么、为什么这么做、做完下一步是什么。你点头确认，才带你进入下一步。',
  p3: '我们的 AI 教练会先问清你的经历、能投入的时间和顾虑，从里面挑出别人替代不了的那部分，定成你的方向。之后每周的选题都从这个方向出发。',
  p4: '我们的 AI 教练会抓取对标账号和你自己账号的真实公开数据，一项项对比，找出差距在哪，再告诉你下一条具体改什么。',
  p5: '我们的 AI 教练不是一次性的课。做完一步就告诉你下一步；中途停下也没关系，下次打开接着聊，之前的进度都记着。',
  p8: '我们的 AI 教练按你的方向，每周提前排好要发的内容，并写清为什么发这条。你只管拍摄，标题、文案、发布和复盘交给 AI 教练。',
};

/**
 * OWNER (2026-10-15, "副标题用 AI 教练版"): the first screen's promise without "它". The shared HERO.promise still says
 * "运营从此交给它"; it changes with it when sample J replaces the public landing page.
 */
export const J_HERO_PROMISE = '运营从此交给我们的 AI 教练，你只管专心输出你擅长的内容。';

/**
 * Forum users' IDs, shown in full (Owner 2026-10-14: "论坛用户的 ID，完整显示、不放原贴连接"). They must be copied
 * verbatim from the local quote table; until they are, each forum note shows this placeholder.
 */
export const J_ID_PLACEHOLDER = '【用户 ID 待补】';
export const J_NOTE_IDS: Readonly<Record<string, string>> = {
  // Checked on the live pages on 2026-10-14 (read only); the quotes still match word for word.
  p2: '黑龙骑士',
  p3: '@KAOCHI999',
  // p5: the piece is supplied by 享民頭條 (written by its editor); the Owner chose the outlet, not a personal name.
  p5: '享民頭條撰文',
  p7: 'u/DrRZXQ',
  // p8: kept as quoted (Owner 2026-10-14), credited to the account that wrote it.
  p8: 'u/huttleai',
};
/** Notes quoted from forums or comments (the rest are people quoted in news reports, who have no ID). */
export const J_FORUM_NOTES: readonly string[] = ['p2', 'p3', 'p5', 'p7', 'p8'];

/** "平台 · 用户 ID · 日期" for a forum note, the report's own wording for a news quote. */
export function noteSource(id: string, source: string) {
  if (!J_FORUM_NOTES.includes(id)) return source;
  const [platform, date] = source.split('，');
  return [platform, J_NOTE_IDS[id] ?? J_ID_PLACEHOLDER, date].filter(Boolean).join(' · ');
}

export const J_TAKEOVER = {
  /** OWNER (2026-10-14), verbatim. */
  benchmarkLine: 'AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。',
  /** NEW */
  juryTitle: '评审团帮你把关报告（Gold）',
  /** NEW, condensed from the jury prototype's own explanation. */
  juryBody: '正式报告生成后，可以开启评审团：三位评审各自读完、在页边批注，意见不一的地方辩论一轮，再逐条裁决、写出修订稿。用不用修订稿，由你逐章决定。',
} as const;

/** The voice wall's title (Owner 2026-10-14: "你是不是也这样？"; the Owner removed the lead in the live edit mode). */
export const J_VOICE = {
  title: '你是不是也这样？',
} as const;

/** The price block. "正常方案要花多少钱" is the Owner's wording; the own-price line and the link are NEW. */
export const J_PRICE = {
  title: '价格',
  compareTitle: '正常方案要花多少钱',
  ownPrice: (proMonthly: string) => `Graylum AI：${proMonthly}/月起`,
  sourceLabel: '出处',
  /** NEW: the check date only (the shared note's "上线前再核对一次" is an internal reminder, not for buyers). */
  checked: '价格于 2026-10-12 核对',
  /** NEW (Owner 2026-10-15): the button beside our price. */
  more: '了解完整价格和权益',
  unavailable: '会员方案暂时读不到，请稍后刷新，或先看价格页。',
} as const;

/** NEW (diagnosis #979 item 20): FAQ wording made less absolute, as [shown on /landing, shown on sample J]. */
export const J_FAQ_REWORDS: readonly (readonly [string, string])[] = [
  ['AI教练的所有功能都尽量做到了一键使用。', 'AI 教练的大部分操作都尽量做成了点一下就能完成。'],
];

/**
 * OWNER (2026-10-15, "结尾文案用 A"): the close — title, line, button and the note under it. Replaces the three drafts;
 * never "它", no credit amount.
 */
export const J_FINAL = {
  title: '还没想好做什么？正好从这里开始',
  line: '不用先想清楚，也不用先有作品。把你的工作、能投入的时间和一点想法说给 AI 教练，AI 教练帮你理出适合你的方向，还有第一周可以先发哪几条。',
  cta: '免费开始聊',
  note: '先免费试，觉得有用再开通。',
} as const;
