/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DetailSection, JuryDetail } from '@/components/landing/preview-jury/jury-events';
import type { ReaderReport } from '@/components/landing/preview-jury/jury-reader';
import { WHOLE_DOCUMENT } from '@/components/landing/preview-jury/jury-report';
import { findScenario } from '@/components/landing/preview-jury/jury-scripts';
import { J_REPORT, J_REVISION } from '@/lib/landing/landing-copy-j-takeover';
import { asCanvasPlace, mapText } from './jury-case-j';

/**
 * The jury's result page (#1004's JuryReader) for this page's report: the report it reads is J_REPORT, chapter by
 * chapter in the canvas's naming ("第 3 章 受众"), and the review is the prototype's full review moved onto it
 * (mapText). Where the prototype's chapters fold into one of this report's (定位一句话 and 差异化 both into 6 账号定位),
 * their rulings are put together; the changed chapters' texts are J_REVISION's, so the page, the canvas and the
 * result say the same thing.
 */
const place = (title: string) => asCanvasPlace(title);
const revisionOf = (section: string) => J_REVISION.changes.find(change => place(change.chapter) === section);

/** The first sentence of a chapter's text, for its one-line digest. */
const firstSentence = (text: string) => /^[^。！？]*[。！？]?/.exec(text)?.[0] ?? text;

export const J_READER_REPORT: ReaderReport = {
  chapters: J_REPORT.chapters.map(chapter => {
    const title = place(chapter.title);
    const [, number = '', name = title] = /^(第 \d+ 章) (.+)$/.exec(title) ?? [];
    return { title, number, name, body: chapter.body };
  }),
  digest: Object.fromEntries(J_REPORT.chapters.map(chapter => [place(chapter.title), { gist: firstSentence(chapter.body), points: [] }])),
  summary: [
    { label: '定位', section: place('6 账号定位'), original: '下班后 15 分钟上桌的家常菜，人设是"会做饭的同事"',
      revised: '下班后 15 分钟上桌的家常菜，快在备菜：周日切配、工作日复用' },
    { label: '受众', section: place('3 受众'), original: '刚开始一个人生活的上班族',
      revised: '刚开始一个人生活的上班族；健身新手放到以后扩展' },
    { label: '平台', section: place('4 平台选择'), original: 'TikTok 和 Instagram 起量，YouTube 放长视频',
      revised: '前两个月三个平台发同一条视频，按数据再定在哪里加重' },
    { label: '变现', section: place('10 变现路径'), original: '先做带货清单，再出菜单和备菜指南',
      revised: '先上线免费一周菜单找到愿意付钱的人，带货放到第二步' },
  ],
  sections: [...J_REPORT.chapters.map(chapter => place(chapter.title)), WHOLE_DOCUMENT],
};

const prototype = JSON.parse(mapText(JSON.stringify(findScenario('full').detail))) as JuryDetail;

function sectionFor(title: string): DetailSection {
  const merged = prototype.summary.sections.filter(item => item.section === title);
  const revision = revisionOf(title);
  const changed = Boolean(revision && merged.some(item => item.changed));
  const linked = [...new Set(merged.flatMap(item => item.linkedSections))].filter(item => item !== title);
  return {
    section: title, changed, rulings: merged.flatMap(item => item.rulings.map(ruling => ({ ...ruling, section: title }))),
    wordingOnly: changed && merged.filter(item => item.changed).every(item => item.wordingOnly),
    ...(changed && revision ? { original: revision.original, revised: revision.revised } : {}),
    fields: changed ? merged.flatMap(item => item.fields) : [], linkedSections: changed ? linked : [],
  };
}

export const J_JURY_DETAIL: JuryDetail = {
  ...prototype,
  reviewId: 'landing-sample-j',
  summary: { ...prototype.summary, sections: J_READER_REPORT.sections.map(sectionFor) },
};
