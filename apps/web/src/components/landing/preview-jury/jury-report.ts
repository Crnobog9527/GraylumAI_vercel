/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { REPORT_SECTIONS } from './jury-mock-reviews';
import { REVISION_TEXT } from './jury-mock-rulings';

/**
 * The mock report under review: one short excerpt per chapter, the same fictional creator as the reviews. The real
 * page shows the user's own frozen report; this only gives the annotations a document to sit on.
 */
const BODY: Record<string, string> = {
  '第 1 章 你是谁': '在写字楼上班的普通职员，每天 19 点到家，晚上只有一小时空闲；会做二十多道家常菜，平时用手机竖拍做饭过程。',
  '第 2 章 定位一句话': '下班后 15 分钟上桌的家常菜，给刚开始一个人生活的上班族。',
  '第 5 章 同类账号': '同类账号大多主打「好吃」或「精致」，单条制作时间长，很少有人专门讲下班后的速度。',
  '第 7 章 人设与语气': '像一个会做饭的同事：说话直接，不炫技，每一步都说清楚为什么这么做。',
  '第 8 章 选题方向': '围绕「一个人、一小时、一顿饭」出题：冰箱剩菜怎么用、一周菜单怎么排、一口锅能做什么。',
  '第 11 章 风险与边界': '不做减肥和医疗建议；不推荐自己没用过的产品；合作内容明确标注。',
  '第 13 章 结语': '先把「15 分钟」这个承诺做扎实，再考虑扩展人群和内容形式。',
};

/** The summary's whole-document entry: not a chapter of the page, shown after the last one only if it has notes. */
export const WHOLE_DOCUMENT = '全文';

export type ReportChapter = { title: string; number: string; name: string; body: string };

export const REPORT_CHAPTERS: readonly ReportChapter[] = REPORT_SECTIONS.filter(title => title !== WHOLE_DOCUMENT).map(title => {
  const [, number = '', name = title] = /^(第 \d+ 章) (.+)$/.exec(title) ?? [];
  return { title, number, name, body: REVISION_TEXT[title]?.original ?? BODY[title] ?? '' };
});

export const REPORT_TITLE = '定位报告：下班后 15 分钟家常菜';
