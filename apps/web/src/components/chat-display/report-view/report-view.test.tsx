/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPORT_DATA_FENCE, parseReportBody } from '@repo/api/src/shared/reportData';
import { SAMPLE_REPORT_DATA, sampleReportDataBlock } from '@repo/api/src/shared/reportDataSample';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { SAMPLE_REPORT_BODY, SAMPLE_REPORT_BODY_WITH_DATA, SAMPLE_REPORT_CHAPTER_TITLES } from '../fixtures/report';
import { ReportView } from './report-view';
import { placeFields, splitChapters, splitReasons } from './report-sections';
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
  it('places every field in its chapter, and the ones whose chapter is missing after the end', () => {
    const { byChapter, unplaced } = placeFields(SAMPLE_REPORT_DATA, ['一句话结论', '变现路径（漏斗）']);
    expect(byChapter.get(1)).toEqual(['funnel', 'upgrades', 'income']);
    expect(unplaced).toContain('audience');
    expect(unplaced).not.toContain('funnel');
  });
});

describe('ReportView', () => {
  it('renders a report without data exactly as before', () => {
    expect(html(SAMPLE_REPORT_BODY)).toBe(renderToStaticMarkup(<MessageMarkdown text={SAMPLE_REPORT_BODY} />));
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

  it('says the charts are being prepared while the block is still being written', () => {
    const out = html(`${SAMPLE_REPORT_BODY}\n\n${REPORT_DATA_FENCE}\n{"v":1,"field":"summ`, { streaming: true });
    expect(out).toContain('图表和策略要点整理中');
    expect(out).not.toContain('summ');
    const stopped = `${SAMPLE_REPORT_BODY}\n\n${REPORT_DATA_FENCE}\n{"v":1,"field":"summ`;
    expect(html(stopped)).toBe(renderToStaticMarkup(<MessageMarkdown text={SAMPLE_REPORT_BODY} />));
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

  it('shows the plain text when there are no chapters at all', () => {
    expect(html(`只有一段。\n\n${sampleReportDataBlock()}`)).toBe(renderToStaticMarkup(<MessageMarkdown text="只有一段。" />));
  });
});
