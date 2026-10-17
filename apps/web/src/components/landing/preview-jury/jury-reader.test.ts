import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SEAT_NAMES, type JuryDetail, type RulingFields } from './jury-events';
import { Done } from './JuryReaderActions';
import { readerChapters, summaryLines, type ReaderSource } from './jury-reader';
import { JuryReader } from './JuryReader';

const ruling = (section: string, opinion: string): RulingFields => ({
  section, issue: '问题', reviewers: ['A'], single: true, disputed: false, opinion, reason: '理由写在这里，足够长。', fix: '改法', adopted: false,
});
/** A real report: its own chapters, no reading aids. */
const source: ReaderSource = { chapters: [
  { title: '定位', number: '', name: '定位', body: '下班后十五分钟的家常菜。给刚独居的上班族。' },
  { title: '结语', number: '', name: '结语', body: '先把承诺做扎实。再扩展人群。' },
] };
const detail = (sections: JuryDetail['summary']['sections']): JuryDetail => ({
  reviewId: 'r', state: 'completed', outcome: 'no_change', revisionId: null, seats: [], adoption: null, awaitingChoice: false,
  summary: { status: 'usable', sections },
});
const wholeOnly = detail([{ section: '全文', changed: false, wordingOnly: false, fields: [], linkedSections: [],
  rulings: [ruling('全文', '全文的语气要统一')] }]);

describe('result page on a real report', () => {
  it('gives notes about the whole report their own card after the last chapter (#1004)', () => {
    expect(readerChapters(wholeOnly, source).map(chapter => chapter.title)).toEqual(['定位', '结语', '全文']);
    const html = renderToStaticMarkup(createElement(JuryReader, { detail: wholeOnly, names: DEFAULT_SEAT_NAMES, source }));
    expect(html).toContain('id="chapter-全文"');
    // Without notes about the whole report there is no such card.
    expect(readerChapters(detail([]), source).map(chapter => chapter.title)).toEqual(['定位', '结语']);
  });

  it('hides 跳到下一处 when no chapter is flagged, and offers no choice when nothing changed (#1004)', () => {
    const html = renderToStaticMarkup(createElement(JuryReader, { detail: wholeOnly, names: DEFAULT_SEAT_NAMES, source }));
    expect(html).not.toContain('跳到下一处');
    expect(html).not.toContain('已选 0/0');
    expect(html).toContain('评审团认为这份报告不需要修改');
  });

  it('uses the chapter\'s first sentence as its line and leaves out the mock one-page summary', () => {
    const chapters = readerChapters(detail([]), source);
    expect(chapters[0]!.digest).toEqual({ gist: '下班后十五分钟的家常菜。', points: [] });
    expect(summaryLines(detail([]), source)).toEqual([]);
    const html = renderToStaticMarkup(createElement(JuryReader, { detail: detail([]), names: DEFAULT_SEAT_NAMES, source }));
    expect(html).not.toContain('小林');
    expect(html).not.toContain('下班后 15 分钟');
  });

  it('still lists the jump button when a chapter changed', () => {
    const changed = detail([{ section: '定位', changed: true, wordingOnly: false, original: '旧的。', revised: '新的。', fields: [],
      linkedSections: [], rulings: [{ ...ruling('定位', '写清人群'), adopted: true }] }]);
    const html = renderToStaticMarkup(createElement(JuryReader, { detail: { ...changed, outcome: 'revised', awaitingChoice: true },
      names: DEFAULT_SEAT_NAMES, source }));
    expect(html).toContain('跳到下一处改动');
    expect(html).toContain('已选 0/1');
  });
});

describe('endings that are not a revision', () => {
  it('shows a review that kept the report as it is as a normal ending, never as a failed revision', () => {
    const kept: JuryDetail = { ...detail([]), outcome: 'no_change', summary: { status: 'none', sections: [] },
      seats: [{ seat: 'A', rounds: [{ round: 1, status: 'usable', decisions: [], issues: [{ location: '定位', perspective: '受众',
        problem: '可以再具体一点。', suggestion: '写出年龄段', severity: 'minor' }] }] }] };
    const html = renderToStaticMarkup(createElement(JuryReader, { detail: kept, names: DEFAULT_SEAT_NAMES, source }));
    expect(html).toContain('评审团认为这份报告不需要修改');
    expect(html).not.toContain('没有生成成功');
    expect(html).toContain('供你参考；报告保持原样');
    const failed = renderToStaticMarkup(createElement(JuryReader, { detail: { ...kept, outcome: 'revision_failed' },
      names: DEFAULT_SEAT_NAMES, source }));
    expect(failed).toContain('修订稿没有生成成功');
  });

  it('says a refused adoption was not applied, not that everything was kept', () => {
    const html = renderToStaticMarkup(createElement(Done, { result: { state: 'recorded', versionId: null, adopted: [], kept: ['定位'],
      refused: 'REPORT_REVISION_STALE' } }));
    expect(html).toContain('这次修改没有采用成功');
    expect(html).not.toContain('全部保留原文');
  });
});
