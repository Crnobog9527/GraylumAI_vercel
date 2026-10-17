/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { REPORT_DATA_CHAPTER, REPORT_DATA_FIELD_NAMES } from './reportDataSpec';
import { editedReportFields, reportChapterName, reportDisplayTitle } from './reportDataText';

/** The 14 chapter titles of the positioning Skill (v14 with writing hints, v15 without). */
const SKILL_TITLES = ['一句话结论', '一、你的现状盘点', '二、你真正想要的结果，以及这条路能不能走通', '三、你的受众：谁会看，谁会买', '四、平台选择',
  '五、对标账号分析', '六、账号定位', '七、账号三件套', '八、内容规划', '九、运营手册：照着做就行', '十、变现路径：销售漏斗和商业飞轮', '十一、合规提醒',
  '十二、关于见效时间和投入', '十三、待验证的假设'];
const WITH_HINTS = ['（约 200 字）', '（约 300 字）', '（约 500 字）', '（约 1300 字）', '（约 300 字）', '（约 800 字，3–10 个合格账号）', '（约 400 字）',
  '（约 700 字）', '（约 1300 字）', '（约 2400 字）', '（至少 2000 字，建议约 2400 字）', '（约 300 字，每份报告必写）', '（约 150 字）', '（约 800 字）'];

describe('chapter names', () => {
  it('maps every Skill chapter (with or without its writing hint) to a chapter the data can be placed in', () => {
    SKILL_TITLES.forEach((title, index) => {
      expect(reportChapterName(title), title).toBeDefined();
      expect(reportChapterName(title + WITH_HINTS[index]), title).toBe(reportChapterName(title));
      expect(reportDisplayTitle(title + WITH_HINTS[index])).toBe(title);
    });
  });
  it('places every data field in one of the Skill chapters', () => {
    const chapters = new Set(SKILL_TITLES.map(title => reportChapterName(title)));
    for (const field of REPORT_DATA_FIELD_NAMES) expect(chapters.has(REPORT_DATA_CHAPTER[field]), field).toBe(true);
  });
  it('finds the fields of a chapter whose text was edited, whatever its title says', () => {
    const generated = SKILL_TITLES.map(title => `## ${title}\n\n原文`).join('\n\n');
    const edited = generated.replace('原文\n\n## 三、', '改过\n\n## 三、');
    expect(editedReportFields(generated, edited)).toEqual(['goal']);
  });
});
