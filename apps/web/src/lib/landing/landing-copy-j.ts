/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Wording that only style sample J uses (PUBLIC-SITE, Owner 2026-10-14). Everything marked NEW is a draft for the
 * Owner to approve (it is listed in the copy-change list handed over with the sample); OWNER is the Owner's own
 * wording, verbatim. The shared landing copy stays in landing-copy.ts.
 */

/** NEW: one heading per voice-wall answer, matching the pain on the left (replaces the shared "教练怎么做"). */
export const J_NOTE_HEADS: Readonly<Record<string, string>> = {
  p1: '24 小时都有人回你',
  p2: '每一步都告诉你具体怎么做',
  p3: '从你的经历里挖出能拍的',
  p4: '用真实数据找到差在哪',
  p5: '一直有人陪你往下走',
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
  p5: '鄭欣宜',
  p7: 'u/DrRZXQ',
  // p8: the quoted reply comes from a marketing tool's account, not a shop owner; the Owner decides whether to replace
  // the quote, so it keeps the placeholder for now.
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
  /** OWNER: the 3a title. */
  positioningTitle: '账号定位策略分析',
  /** NEW */
  positioningBody: '和教练聊三步：先说清你是谁，再判断往哪个方向做，最后找到值得参考的对标账号。这一段可以免费体验。',
  /** OWNER (2026-10-14), verbatim. */
  benchmarkLine: 'AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。',
  /** NEW */
  juryTitle: '评审团帮你把关报告（Gold）',
  /** NEW, condensed from the jury prototype's own explanation. */
  juryBody: '正式报告生成后，可以开启评审团：三位评审各自读完、在页边批注，意见不一的地方辩论一轮，再逐条裁决、写出修订稿。用不用修订稿，由你逐章决定。',
  /** NEW: the long promise paragraph split into points, one short line each (the last one is the Owner's own). */
  promises: [
    { id: 'topics', title: '不用自己想选题', line: '每周发什么、为什么发这条，它替你排好。' },
    { id: 'method', title: '不用研究运营技术', line: '运营方法都装在教练里，你照着做就行。' },
    { id: 'data', title: '不用自己看数据', line: '每周告诉你哪条有效、下周怎么调。' },
  ],
  /** NEW: the third chapter's title. */
  promisesTitle: '这些事，不用你再操心',
  /** From the Owner's final copy (HOW_IT_WORKS.promise), verbatim. */
  promiseClose: '拍摄、出镜、录音这些要你本人来，其余交给它。',
} as const;

/** NEW: the sample content of the positioning clip's second and third phases (the demo's fictional case). */
export const J_POSITIONING_SAMPLE = {
  direction: '帮刚到加拿大的新移民，用下班时间一步步转行做牙科助理',
  reminder: '护理和省钱话题牙医都在讲，你作为助理不占优势；主线放在你自己的入行经历上。',
  directionReply: '方向我替你判断过了：主线讲你自己走过的入行路，帮想转行的新移民少走弯路。',
  benchmarkKinds: ['职业转型类账号', '新移民生活类账号', '牙科从业者账号'],
} as const;

/** The first screen's data-growth flywheel. Steps are the product's real ones; label and caption are NEW. */
export const J_FLYWHEEL = {
  label: '数据增长飞轮：定位、选题、创作、发布、看数据复盘，再回到调整定位和选题',
  steps: ['定位', '选题', '创作', '发布', '看数据复盘'],
  caption: '每转一圈，按数据调整一次，账号往上走一步',
} as const;

/** The voice wall's title and lead (Owner 2026-10-14: "你是不是也这样？", the lead without "左边／右边"; lead NEW). */
export const J_VOICE = {
  title: '你是不是也这样？',
  lede: '这些是公开论坛和媒体报道里的原话。每一条旁边，是教练怎么帮你解决。',
} as const;

/** The pictures in "不用自己想选题 / 不用研究运营技术": from the demo's sample report (demo-script.ts REPORT_BODY). */
export const J_PROMISE_SAMPLES = {
  weeks: ['第 1 周：讲清你自己是怎么入行的', '第 2 周：入行要准备的证书和课程', '第 3 周：第一份工作怎么找'],
  basics: ['账号名字', '账号简介', '头像和封面'],
} as const;
