/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Wording that only style sample J uses (PUBLIC-SITE, Owner 2026-10-14). Everything marked NEW is a draft for the
 * Owner to approve (it is listed in the copy-change list handed over with the sample); OWNER is the Owner's own
 * wording, verbatim. The shared landing copy stays in landing-copy.ts.
 */

/** NEW: one heading per voice-wall answer, matching the pain on the left (replaces the shared "教练怎么做"). */
export const J_NOTE_HEADS: Readonly<Record<string, string>> = {
  p1: 'AI 教练 24 小时随时回你',
  p2: '每一步都告诉你具体怎么做',
  p3: '从你的经历里挖出能拍的',
  p4: '用真实数据找到差在哪',
  p5: 'AI 教练一直陪你往下走',
  p7: '先替你判断，再给内容',
  p8: '每周照着清单做就行',
};

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

/** NEW: the sample content of the positioning clip's second and third phases (the demo's fictional case). */
export const J_POSITIONING_SAMPLE = {
  direction: '帮刚到加拿大的新移民，用下班时间一步步转行做牙科助理',
  reminder: '护理和省钱话题牙医都在讲，你作为助理不占优势；主线放在你自己的入行经历上。',
  directionReply: '方向我替你判断过了：主线讲你自己走过的入行路，帮想转行的新移民少走弯路。',
  benchmarkKinds: ['职业转型类账号', '新移民生活类账号', '牙科从业者账号'],
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
  more: '看完整价格和权益',
  unavailable: '会员方案暂时读不到，请稍后刷新，或先看价格页。',
} as const;

/** NEW (diagnosis #979 item 20): FAQ wording made less absolute, as [shown on /landing, shown on sample J]. */
export const J_FAQ_REWORDS: readonly (readonly [string, string])[] = [
  ['AI教练的所有功能都尽量做到了一键使用。', 'AI 教练的大部分操作都尽量做成了点一下就能完成。'],
];
