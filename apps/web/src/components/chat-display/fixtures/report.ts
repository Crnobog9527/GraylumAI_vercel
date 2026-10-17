/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReportChapter } from '../report-outline';

/**
 * Sample data for the report dialog and its chapter list, shared by the landing page and the component
 * tests. Made-up example content only: no real user, no real account. The chapter names follow the
 * paywall design (v25): a one-line conclusion and the 13 chapters of the operating strategy report.
 */

export const SAMPLE_REPORT_CHAPTER_TITLES = [
  '一句话结论', '现状盘点', '目标和可行性', '受众', '平台选择', '对标账号分析', '账号定位',
  '账号三件套', '内容规划', '运营手册', '变现路径', '合规提醒', '见效时间', '待验证的假设',
];

export const SAMPLE_REPORT_CHAPTERS: ReportChapter[] =
  SAMPLE_REPORT_CHAPTER_TITLES.map((title, index) => ({ id: 'chapter-' + index, title }));

/** The chapter being read in the sample (受众). */
export const SAMPLE_REPORT_ACTIVE_CHAPTER = 'chapter-3';

const SAMPLE_SECTIONS: Record<string, string> = {
  一句话结论: '在小红书做"烘焙师的定制蛋糕日常"，三个月内每周稳定接到 3–5 个定制单是可以做到的。',
  现状盘点: '- 你已有烘焙手艺和老客户\n- 每周能拿出 3–10 小时做内容\n- 还没有自己的账号',
  目标和可行性: '同城定制蛋糕需求稳定，客单价能覆盖做内容的时间；难点在于前两个月的持续更新。',
  受众: '- **筹备生日和纪念日的年轻妈妈**：看重颜值和安全\n- **公司行政**：看重准时交付和开票',
  平台选择: '主做小红书（同城搜索多、图文门槛低），抖音先只同步，不单独投入。',
  对标账号分析: '在真实产品里，对标账号的数据由程序实时查出、算出；这个示例不展示数字。',
  账号定位: '一个会讲做法的烘焙师：每条内容只讲一个蛋糕从设计到交付的过程。',
  账号三件套: '- **名字：** 小麦的定制蛋糕日记\n- **简介：** 同城定制 · 每一个蛋糕的故事\n- **头像：** 工作台实拍',
  内容规划: '每周 3 条：1 条成品展示、1 条制作过程、1 条客户故事。',
  运营手册: '- 每条发布后 1 小时内回复评论\n- 每周看一次收藏数，删掉连续三周最差的选题类型',
  变现路径: '先用作品集带来同城私信，再推出节日限定款，最后做烘焙小课。',
  合规提醒: '食品类账号不承诺功效；展示的客户照片先征得同意。',
  见效时间: '一般 4–8 周开始有稳定私信；以你每周的更新量为前提。',
  待验证的假设: '- 同城用户愿意为设计溢价付费\n- 制作过程类内容的收藏率高于成品展示',
};

/** A short sample report body in the report's markdown shape: one `##` heading per chapter. */
export const SAMPLE_REPORT_BODY = SAMPLE_REPORT_CHAPTER_TITLES
  .map(title => `## ${title}\n\n${SAMPLE_SECTIONS[title]}`).join('\n\n');
