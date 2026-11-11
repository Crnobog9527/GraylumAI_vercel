/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * What the modules of region 3 say inside their pictures (Owner 2026-11-11: "中间的过程可以加速甚至简略一点……文字也太多
 * 了"). Nothing here is new wording: every line is cut, unchanged, out of the approved scripts, which stay whole as the
 * record these are checked against (flow-l.test.ts): step one's out of sample L's positioning conversation
 * (landing-copy-l-positioning.ts), steps two and three's out of landing-copy-l-later.ts.
 */
export const L_FLOW_ONE = {
  know: {
    /** The coach's second question, from its reply to the goal. */
    ask: '**你希望谁来看你的内容？能不能想一个你真认识的人？**',
    /** The first sentence of the person's answer. */
    answer: '想吸引的就是跟我一样，刚开始一个人住的上班族。',
    /** The checklist: the goal was written down by the question before; this answer fills the audience. */
    before: ['goal'],
    fills: 'audience',
  },
  diagnose: {
    /** The Owner's sentence on where the benchmark figures come from (2026-10-14), verbatim. */
    fetch: 'AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。',
  },
  plan: {
    position: '把前两步收成一句话定位：**下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族。**',
    agree: '可以，就这个。',
    summary: '三步都齐了。确认后就可以生成完整报告，里面会把每一部分展开写。',
  },
} as const;

export const L_FLOW_LATER = {
  /** The two sentences that lead the title table and the cover table in the coach's reply. */
  coverLead: '先给 10 个标题，每个标了用的什么钩子（数据为示意）：',
  coverSecond: '再给 10 种封面做法：',
  /** The coach's pick, its first sentence. */
  coverPick: '**我推荐**：标题用 **#1**，备选 **#6**；封面用 **#2**，长期加上 **#10** 的系列模板。',
  /** The storyboard's columns in a module: the spoken lines are the script itself, shown above it. */
  shotColumns: [0, 1, 2, 4],
  /** How many paragraphs of the script the picture writes out. */
  scriptParagraphs: 1,
  /** How many fields of each platform's card the picture shows. */
  monitorFields: 4,
} as const;
