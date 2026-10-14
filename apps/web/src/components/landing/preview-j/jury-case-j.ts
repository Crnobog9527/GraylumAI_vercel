/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { mockCase, type JuryCase } from '@/components/landing/preview-jury/jury-case';
import { J_REPORT, J_REVISION } from '@/lib/landing/landing-copy-j-takeover';

/**
 * #1002's prototype report uses its own chapter names ("第 4 章 受众画像"); sample J's report has the real 13 chapters
 * ("3 受众"). So that the canvas, the report and the revised chapters name the same places, the prototype's review is
 * replayed with each of its chapters moved to the closest chapter of this report. The shared canvas is not changed.
 */
const CHAPTER_MAP: Record<string, string> = {
  '第 1 章 你是谁': '1 现状盘点',
  '第 2 章 定位一句话': '6 账号定位',
  '第 3 章 差异化': '6 账号定位',
  '第 4 章 受众画像': '3 受众',
  '第 5 章 同类账号': '5 对标账号分析',
  '第 6 章 平台选择': '4 平台选择',
  '第 7 章 人设与语气': '7 账号三件套',
  '第 8 章 选题方向': '8 内容规划',
  '第 9 章 内容支柱': '8 内容规划',
  '第 10 章 变现路径': '10 变现路径',
  '第 11 章 风险与边界': '11 合规提醒',
  '第 12 章 30 天行动': '12 见效时间',
  '第 13 章 结语': '13 待验证的假设',
};

/** "3 受众" → "第 3 章 受众", the canvas's way of naming a place. */
const asCanvasPlace = (title: string) => title.replace(/^(\d+) /, '第 $1 章 ');

/** Every prototype chapter name in the text, also the short "第 6 章" form, moved to this report's numbering. */
export function mapChapters(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(CHAPTER_MAP)) out = out.split(from).join(asCanvasPlace(to));
  return out.replace(/第 (\d+) 章(?! )/g, (whole, number: string) => {
    const full = Object.keys(CHAPTER_MAP).find(name => name.startsWith(`第 ${number} 章 `));
    return full ? asCanvasPlace(CHAPTER_MAP[full]).replace(/ \S+$/, '') : whole;
  });
}

const prototype = mockCase('full');

export const J_JURY_CASE: JuryCase = {
  report: {
    title: J_REPORT.title,
    excerpt: J_REPORT.chapters.slice(0, 2).map(item => item.body).join(' '),
    chapters: J_REPORT.chapters.length - 1,
    revisedExcerpt: J_REVISION.changes.slice(0, 2).map(item => item.revised).join(' '),
  },
  arrivals: JSON.parse(mapChapters(JSON.stringify(prototype.arrivals))) as JuryCase['arrivals'],
};
