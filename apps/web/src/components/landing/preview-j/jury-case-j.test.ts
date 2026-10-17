import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { REPORT_SECTIONS } from '@/components/landing/preview-jury/jury-mock-reviews';
import { QuestionCardView } from '@/components/opc/question-card';
import { J_PERSONA_GOAL, J_QUESTION_HEADING } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT, J_REVISION } from '@/lib/landing/landing-copy-j-takeover';
import { JuryReader } from '@/components/landing/preview-jury/JuryReader';
import { resolveSeatNames, SAMPLE_PANEL } from '@/components/landing/preview-jury/jury-events';
import { J_JURY_CASE } from './jury-case-j';
import { J_JURY_DETAIL, J_READER_REPORT } from './jury-reader-j';
import { plainText } from '@/lib/landing/sample-reports/report-markdown';

/** "3 受众" as the canvas names it: "第 3 章 受众". */
const canvasPlace = (title: string) => title.replace(/^(\d+) /, '第 $1 章 ');

describe('sample J names the report chapters one way everywhere', () => {
  it('the revised chapters are chapters of the report, with its own text as 改前', () => {
    const titles = J_REPORT.chapters.map(item => item.title);
    expect(J_REVISION.changes).toHaveLength(6);
    for (const change of J_REVISION.changes) {
      expect(titles).toContain(change.chapter);
      expect(change.original).toBe(plainText(J_REPORT.chapters.find(item => item.title === change.chapter)?.body ?? ''));
      expect(change.revised).not.toBe(change.original);
    }
  });

  it('the jury canvas plays the real review, on this report\'s chapters', () => {
    const text = JSON.stringify(J_JURY_CASE.arrivals);
    for (const old of REPORT_SECTIONS.filter(name => name !== '全文')) {
      if (!J_REPORT.chapters.some(item => canvasPlace(item.title) === old)) expect(text).not.toContain(old);
    }
    const places = new Set([...text.matchAll(/第 \d+ 章 [^"，。：、」\s]+/g)].map(match => match[0]));
    const known = new Set(J_REPORT.chapters.map(item => canvasPlace(item.title)));
    for (const place of places) expect(known.has(place)).toBe(true);
    // The prototype's own review (another person, another platform) is gone.
    for (const old of ['少油少盐', '小红书', '抖音', '视频号']) expect(text).not.toContain(old);
    // Nine rulings: seven taken, two turned down because they clash with what the person said.
    const rulings = J_JURY_CASE.arrivals.flatMap(arrival => arrival.events).filter(event => event.type === 'adjudication');
    expect(rulings).toHaveLength(9);
    expect(rulings.filter(event => event.type === 'adjudication' && !event.adopted)).toHaveLength(2);
    expect(J_JURY_CASE.report.chapters).toBe(13);
  });

  it('the public site calls the question card the AI coach\'s', () => {
    const html = renderToStaticMarkup(createElement(QuestionCardView, { card: J_PERSONA_GOAL, heading: J_QUESTION_HEADING }));
    expect(html).toContain('AI 教练提问');
    expect(html).not.toContain('导师');
    expect(J_REPORT.intro).not.toContain('导师');
  });

  it('the result page (JuryReader) reads this report: its chapters, the six changes, no prototype names or platforms', () => {
    const html = renderToStaticMarkup(createElement(JuryReader, {
      detail: J_JURY_DETAIL, names: resolveSeatNames(SAMPLE_PANEL), source: J_READER_REPORT,
    }));
    for (const chapter of J_REPORT.chapters) expect(html).toContain(canvasPlace(chapter.title));
    // The prototype's chapter names are gone (its reviewers may still use words like 受众画像 inside an opinion).
    for (const old of REPORT_SECTIONS.filter(name => name !== '全文')) {
      if (!J_REPORT.chapters.some(item => canvasPlace(item.title) === old)) expect(html).not.toContain(old);
    }
    for (const old of ['小红书', '抖音', '视频号', '原型：模拟提交被拒']) expect(html).not.toContain(old);
    expect(J_JURY_DETAIL.summary.sections.filter(section => section.changed).map(section => section.section))
      .toEqual(J_REVISION.changes.map(change => canvasPlace(change.chapter)));
    expect(html).toContain('评审改了 6 章');
  });
});
