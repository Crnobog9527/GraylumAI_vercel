import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { REPORT_SECTIONS } from '@/components/landing/preview-jury/jury-mock-reviews';
import { QuestionCardView } from '@/components/opc/question-card';
import { J_PERSONA_QUESTION, J_QUESTION_HEADING } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT, J_REVISION } from '@/lib/landing/landing-copy-j-takeover';
import { J_JURY_CASE, mapChapters } from './jury-case-j';

/** "3 受众" as the canvas names it: "第 3 章 受众". */
const canvasPlace = (title: string) => title.replace(/^(\d+) /, '第 $1 章 ');

describe('sample J names the report chapters one way everywhere', () => {
  it('the revised chapters are chapters of the report, with its own text as 改前', () => {
    const titles = J_REPORT.chapters.map(item => item.title);
    expect(J_REVISION.changes).toHaveLength(6);
    for (const change of J_REVISION.changes) {
      expect(titles).toContain(change.chapter);
      expect(change.original).toBe(J_REPORT.chapters.find(item => item.title === change.chapter)?.body);
      expect(change.revised).not.toBe(change.original);
    }
  });

  it('the jury canvas plays with the report chapters, none of the prototype ones', () => {
    const text = JSON.stringify(J_JURY_CASE.arrivals);
    for (const old of REPORT_SECTIONS.filter(name => name !== '全文')) {
      if (!J_REPORT.chapters.some(item => canvasPlace(item.title) === old)) expect(text).not.toContain(old);
    }
    const places = new Set([...text.matchAll(/第 \d+ 章 [^"，。：、」\s]+/g)].map(match => match[0]));
    const known = new Set(J_REPORT.chapters.map(item => canvasPlace(item.title)));
    for (const place of places) expect(known.has(place)).toBe(true);
    // Every chapter the panel raises is one the revision changes.
    const revised = new Set(J_REVISION.changes.map(change => canvasPlace(change.chapter)));
    for (const place of places) expect(revised.has(place)).toBe(true);
    expect(J_JURY_CASE.report.chapters).toBe(13);
  });

  it('short chapter references move with the full names', () => {
    expect(mapChapters('第 6 章提到你')).toBe('第 4 章提到你');
    expect(mapChapters('第 4 章 受众画像')).toBe('第 3 章 受众');
  });

  it('the public site calls the question card the AI coach\'s', () => {
    const html = renderToStaticMarkup(createElement(QuestionCardView, { card: J_PERSONA_QUESTION, heading: J_QUESTION_HEADING }));
    expect(html).toContain('AI 教练提问');
    expect(html).not.toContain('导师');
    expect(J_REPORT.intro).not.toContain('导师');
  });
});
