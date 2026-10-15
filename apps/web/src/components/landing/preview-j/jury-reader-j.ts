/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { DetailSection, JuryDetail } from '@/components/landing/preview-jury/jury-events';
import type { ReaderReport } from '@/components/landing/preview-jury/jury-reader';
import { WHOLE_DOCUMENT } from '@/components/landing/preview-jury/jury-report';
import { J_REVISION } from '@/lib/landing/landing-copy-j-takeover';
import { OFFICE_WORKER_REPORT } from '@/lib/landing/sample-reports/office-worker';
import { plainText } from '@/lib/landing/sample-reports/report-markdown';
import { asCanvasPlace } from './jury-case-j';
import { J_REVIEW_SEATS, J_RULINGS } from './jury-review-j';

/**
 * The jury's result page (#1004's JuryReader) for this page's person, from the real review of 2026-10-15 (the review
 * Skill on the real report: review.md, report-revised.md). The page reads the revised report; the six chapters the
 * chief writer changed in substance are lit, each with the rulings behind it, including the two suggestions it turned
 * down because they clash with what the person said ("周末不一定有空", "每周两条"). Rulings are the review's own,
 * shortened. Chapters 一, 五 and 七 were not changed; 一句话结论, 二, 九, 十一 and 十三 only followed the six.
 */
const place = (title: string) => asCanvasPlace(title);
const firstSentence = (text: string) => /^[^。！？\n]*[。！？]?/.exec(text)?.[0] ?? text;

export const J_READER_REPORT: ReaderReport = {
  chapters: OFFICE_WORKER_REPORT.revised.map(chapter => {
    const title = place(chapter.title);
    const [, number = '', name = title] = /^(第 \d+ 章) (.+)$/.exec(title) ?? [];
    return { title, number, name, body: plainText(chapter.markdown) };
  }),
  digest: Object.fromEntries(OFFICE_WORKER_REPORT.revised.map(chapter => [
    place(chapter.title), { gist: firstSentence(plainText(chapter.markdown)), points: [] },
  ])),
  summary: [
    { label: '定位', section: place('6 账号定位'), original: '下班后 15 分钟上桌的中式家常菜，给刚开始一个人生活的上班族',
      revised: '同上，快在备菜：买菜当天把三顿的料分好，工作日复用，每条全程计时' },
    { label: '受众', section: place('3 受众'), original: '刚开始一个人生活的上班族',
      revised: '刚开始一个人生活的上班族；补上放弃做饭的原因，健身新手留作以后扩展' },
    { label: '平台', section: place('4 平台选择'), original: 'TikTok 为主，同步 Instagram Reels；YouTube 只放 Shorts 和合集',
      revised: '前两个月三处发同一条视频，按各自数据再决定在哪里加重' },
    { label: '变现', section: place('10 变现路径'), original: '厨具和食材的联盟带货起步，同时用免费一周菜单测试',
      revised: '第一个月末先放免费一周菜单和报名表，带货放第二步（先调料和保鲜盒）' },
  ],
  sections: [...OFFICE_WORKER_REPORT.revised.map(chapter => place(chapter.title)), WHOLE_DOCUMENT],
};

function sectionFor(title: string): DetailSection {
  const rulings = J_RULINGS.filter(item => item.section === title);
  const change = J_REVISION.changes.find(item => place(item.chapter) === title);
  return {
    section: title, changed: Boolean(change), rulings, wordingOnly: false,
    ...(change ? { original: change.original, revised: change.revised } : {}),
    fields: [], linkedSections: [],
  };
}

export const J_JURY_DETAIL: JuryDetail = {
  reviewId: 'landing-sample-j', state: 'completed', outcome: 'revised', revisionId: 'landing-sample-j-revision',
  seats: J_REVIEW_SEATS,
  summary: { status: 'usable', sections: J_READER_REPORT.sections.map(sectionFor) },
  adoption: null,
  awaitingChoice: true,
};
