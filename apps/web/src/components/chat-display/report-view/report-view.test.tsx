/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPORT_DATA_FENCE, parseReportBody } from '@repo/api/src/shared/reportData';
import { SAMPLE_REPORT_DATA, sampleReportDataBlock } from '@repo/api/src/shared/reportDataSample';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { SAMPLE_REPORT_BODY, SAMPLE_REPORT_BODY_WITH_DATA, SAMPLE_REPORT_CHAPTER_TITLES } from '../fixtures/report';
import { ReportView } from './report-view';
import styles from './report-view.module.css';
import { placeFields, reportDisplayTitle, splitChapters, splitReasons, withDisplayHeadings } from './report-sections';
import { REPORT_FIXED_NOTES } from './report-text';

const html = (body: string, extra: Partial<Parameters<typeof ReportView>[0]> = {}) => renderToStaticMarkup(<ReportView body={body} {...extra} />);

describe('report sections', () => {
  it('cuts chapters at `## ` lines only (not `###`, not inside code)', () => {
    const { preamble, chapters } = splitChapters('# 报告\n\n## 一\n正文\n### 理由\n因为\n```\n## 不是\n```\n## 二\n正文二');
    expect(preamble).toBe('# 报告');
    expect(chapters.map(chapter => chapter.title)).toEqual(['一', '二']);
    expect(chapters[0].body).toContain('## 不是');
  });
  it('folds from `### 理由` to the next `###`, and keeps a chapter without it whole', () => {
    expect(splitReasons('结论。\n\n### 理由\n\n因为 A。\n\n### 补充\n\n还有 B。'))
      .toEqual({ main: '结论。\n\n### 补充\n\n还有 B。', reasons: '因为 A。' });
    expect(splitReasons('只有结论。')).toEqual({ main: '只有结论。', reasons: null });
  });
  it.each([
    ['一句话结论（约 200 字）', '一句话结论'],
    ['二、现状盘点（约 300 字）', '二、现状盘点'],
    ['四、受众（约 1500 字）', '四、受众'],
    ['五、对标账号分析（约 800 字，3–10 个合格账号）', '五、对标账号分析'],
    ['十、变现路径：销售漏斗和商业飞轮（至少 2000 字，建议约 2400 字）', '十、变现路径：销售漏斗和商业飞轮'],
    ['十一、运营手册（不超过 2400 字）', '十一、运营手册'],
    ['十二、合规提醒（800 字以内）', '十二、合规提醒'],
    ['十三、见效时间（字数 150 左右）', '十三、见效时间'],
    ['十四、待验证的假设（約 800 字）', '十四、待验证的假设'],
    ['八、内容规划 (约 1300 字)', '八、内容规划'],
    ['九、运营手册：照着做就行（约 2400 字）', '九、运营手册：照着做就行'],
  ])('shows the title %s without its length hint', (title, shown) => expect(reportDisplayTitle(title)).toBe(shown));
  it.each(['账号三件套（昵称建议 4 字，简介 20 字）', '发布节奏（每天写 100 字）', '简介（约 20 字）', '见效时间（约 3 个月）', '预算（约 500 元）', '对标账号分析（3–10 个合格账号）', '变现路径（漏斗）', '定位（B 版）', '一句话结论'])(
    'keeps the business bracket in %s', title => expect(reportDisplayTitle(title)).toBe(title));
  it('drops writing hints from titles for display, and matches numbered titles to chapters', () => {
    expect(reportDisplayTitle('五、对标账号分析（约 800 字，3–10 个合格账号）')).toBe('五、对标账号分析');
    expect(reportDisplayTitle('一句话结论（约 200 字）')).toBe('一句话结论');
    expect(reportDisplayTitle('变现路径（漏斗）')).toBe('变现路径（漏斗）');
    expect(reportDisplayTitle('见效时间（约 3 个月）')).toBe('见效时间（约 3 个月）');
    expect(reportDisplayTitle('预算（约 500 元）')).toBe('预算（约 500 元）');
    expect(withDisplayHeadings('## 一句话结论（约 200 字）\n正文（约 3 条）\n```\n## 代码（约 1 字）\n```'))
      .toBe('## 一句话结论\n正文（约 3 条）\n```\n## 代码（约 1 字）\n```');
    const { byChapter } = placeFields(SAMPLE_REPORT_DATA, ['一句话结论（约 200 字）', '十一、变现路径：销售漏斗（约 2000 字）']);
    expect(byChapter.get(1)).toEqual(['funnel', 'upgrades', 'income']);
  });
  it('places every field in its chapter, and the ones whose chapter is missing after the end', () => {
    const { byChapter, unplaced } = placeFields(SAMPLE_REPORT_DATA, ['一句话结论', '变现路径（漏斗）']);
    expect(byChapter.get(1)).toEqual(['funnel', 'upgrades', 'income']);
    expect(unplaced).toContain('audience');
    expect(unplaced).not.toContain('funnel');
  });
});

describe('ReportView', () => {
  it('renders a report without data exactly as before', () => {
    expect(html(SAMPLE_REPORT_BODY)).toBe(renderToStaticMarkup(<MessageMarkdown className={styles.tables} text={SAMPLE_REPORT_BODY} />));
  });

  it('never shows the data block as text, and keeps one h2 per chapter for the chapter list', () => {
    const out = html(SAMPLE_REPORT_BODY_WITH_DATA);
    expect(out).not.toContain('graylum-report-data');
    expect(out).not.toContain('&quot;field&quot;');
    expect(out.match(/<h2/g)).toHaveLength(SAMPLE_REPORT_CHAPTER_TITLES.length);
    expect(out).not.toMatch(/<h[13]/);
  });

  it('shows the quick look, the five charts and the fixed notes from the data', () => {
    const out = html(SAMPLE_REPORT_BODY_WITH_DATA);
    expect(out).toContain('30 秒看懂');
    expect(out).toContain('这周先做这一件事');
    expect(out).toContain(SAMPLE_REPORT_DATA.thisWeek![0].action);
    expect(out).toContain(SAMPLE_REPORT_DATA.audience!.groups[0].name);
    expect(out).toContain('内容匹配：高');
    expect(out).toContain('示例甜点工作室');
    expect(out).toContain('这些账号暂时没有可以对上的数据');
    expect(out).toContain('约 398–898 元');
    expect(out).toContain('怎样算过关');
    expect(out).toContain(SAMPLE_REPORT_DATA.plan30!.weeks[3].passIf);
    for (const note of Object.values(REPORT_FIXED_NOTES)) expect(out).toContain(note.title);
  });

  it('shows the fields without a chart as tables and lists, columns named from the field definitions', () => {
    const out = html(SAMPLE_REPORT_BODY_WITH_DATA);
    for (const text of ['选题清单', '戳中什么', '这个恐龙蛋糕我改了三次设计', '具体该怎么做', '发之前征得同意，孩子的脸打码',
      '待验证的假设', '不成立怎么办', '小麦的定制蛋糕日记', '红线', '每周固定流程', '升级路径', '收益公式（不写金额）'])
      expect(out).toContain(text);
  });

  it('folds the reasons behind a button, and leaves chapters without them whole', () => {
    const out = html(SAMPLE_REPORT_BODY_WITH_DATA);
    expect(out).toContain('展开理由');
    expect(out).not.toContain('你的客户会先在小红书搜');
    expect(out).toContain('每周 3 条：1 条成品展示');
  });

  it('lists the text of a field that did not pass, without drawing it', () => {
    const body = `## 变现路径\n\n三层。\n\n${REPORT_DATA_FENCE}\n${JSON.stringify({ v: 1, field: 'funnel', value: [{ layer: '免费', offer: '图文' }] })}\n\`\`\``;
    const out = html(body);
    expect(out).toContain('这一项的数据不完整');
    expect(out).toContain('图文');
    expect(out).not.toContain('看这一层的细节');
  });

  it('lists an invalid summary as text in its chapter', () => {
    const long = '长'.repeat(201);
    const out = html(`## 一句话结论\n\n结论。\n\n## 受众\n\n人群。\n\n${REPORT_DATA_FENCE}\n${JSON.stringify({ v: 1, field: 'summary', value: long })}\n\`\`\``);
    expect(out).toContain('这一项的数据不完整');
    expect(out).toContain(long.slice(0, 200));
  });

  it('says the charts are being prepared while the block is still being written', () => {
    const out = html(`${SAMPLE_REPORT_BODY}\n\n${REPORT_DATA_FENCE}\n{"v":1,"field":"summ`, { streaming: true });
    expect(out).toContain('图表和策略要点整理中');
    expect(out).not.toContain('summ');
    const stopped = `${SAMPLE_REPORT_BODY}\n\n${REPORT_DATA_FENCE}\n{"v":1,"field":"summ`;
    expect(html(stopped)).toBe(renderToStaticMarkup(<MessageMarkdown className={styles.tables} text={SAMPLE_REPORT_BODY} />));
  });

  it('draws benchmark numbers only from server data, and marks chapters whose text was edited', () => {
    const parsed = parseReportBody(SAMPLE_REPORT_BODY_WITH_DATA).data!;
    parsed.data.benchmarks!.accounts = parsed.data.benchmarks!.accounts.map((account, index) => ({ ...account,
      metrics: { followers: 12000 + index, medianViews: 3000, engagementRate: 0.052, weeklyPosts: 3, capturedAt: '2026-10-10' } }));
    const out = html(SAMPLE_REPORT_BODY_WITH_DATA, { data: parsed, editedFields: ['funnel'] });
    expect(out).toContain('粉丝 1.2 万');
    expect(out).toContain('5.2%');
    expect(out).toContain('这一章的文字你改过');
    expect(out.match(/这一章的文字你改过/g)).toHaveLength(1);
  });

  it('shows engagement and posting numbers even when followers and views are unknown', () => {
    const parsed = parseReportBody(SAMPLE_REPORT_BODY_WITH_DATA).data!;
    parsed.data.benchmarks!.accounts = parsed.data.benchmarks!.accounts.map(account => ({ ...account,
      metrics: { followers: null, medianViews: null, engagementRate: 0.031, weeklyPosts: 2, capturedAt: null } }));
    const out = html(SAMPLE_REPORT_BODY_WITH_DATA, { data: parsed });
    expect(out).toContain('3.1%');
    expect(out).toContain('2 次');
    expect(out).not.toContain('这些账号暂时没有可以对上的数据');
  });

  it('never shows writing hints in headings, with or without data', () => {
    const hinted = SAMPLE_REPORT_BODY.replace('## 受众', '## 四、受众（约 1500 字）');
    expect(html(hinted)).not.toContain('约 1500 字');
    expect(html(hinted + '\n\n' + sampleReportDataBlock())).not.toContain('约 1500 字');
    expect(html(hinted + '\n\n' + sampleReportDataBlock())).toContain('内容匹配：高');
  });

  it('shows the plain text when there are no chapters at all', () => {
    expect(html(`只有一段。\n\n${sampleReportDataBlock()}`)).toBe(renderToStaticMarkup(<MessageMarkdown className={styles.tables} text="只有一段。" />));
  });
});
