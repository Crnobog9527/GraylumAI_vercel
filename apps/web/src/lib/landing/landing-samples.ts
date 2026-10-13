/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Module 3b: one sample 《运营策略报告》 per audience (offer one-page 3b, brief section 14b). Each report must be
 * generated for real with a demo account once RESEARCH-TOOLS is live, de-identified and marked "示例"; never
 * written by hand. Until then every `sections` entry is empty and the block stays hidden (`sampleReports` in
 * landing-flags.ts). Fill each section with the generated text, paragraph by paragraph, without edits.
 */
export type SampleSectionKey = 'positioning' | 'plan' | 'monetization';

export type SampleReport = {
  id: string;
  audience: string;
  // Generated paragraphs per fixed section; empty until the demo account has produced the report.
  sections: Record<SampleSectionKey, readonly string[]>;
  // True for the report(s) where the coach says the direction is hard to monetise and suggests a change.
  showsHardTruth: boolean;
};

export const SAMPLE_REPORTS_TITLE = '不同人群的样例报告';
export const SAMPLE_LABEL = '示例';

/** The three parts every sample shows, in this order. */
export const SAMPLE_SECTIONS: readonly { key: SampleSectionKey; title: string }[] = [
  { key: 'positioning', title: '一句话定位和为什么' },
  { key: 'plan', title: '第一个 30 天计划' },
  { key: 'monetization', title: '变现路线' },
];

const EMPTY = { positioning: [], plan: [], monetization: [] };

/** Audiences fixed by the Owner on 2026-10-13, in this order. */
export const SAMPLE_REPORTS: readonly SampleReport[] = [
  { id: 'sample-expert', audience: '有一门专业、想做知识付费的上班族', sections: EMPTY, showsHardTruth: false },
  { id: 'sample-shop', audience: '想给店里引流的小店老板', sections: EMPTY, showsHardTruth: false },
  {
    id: 'sample-side',
    audience: '上班族副业，想多一份收入（不一定有专业，靠平台分成、带货或接广告）',
    sections: EMPTY, showsHardTruth: false,
  },
  {
    id: 'sample-young',
    audience: '二十多岁、想靠内容吃饭的年轻人（学生或刚毕业，想从兼职做到全职）',
    sections: EMPTY, showsHardTruth: false,
  },
];

export function sampleReady(report: SampleReport) {
  return SAMPLE_SECTIONS.every(section => report.sections[section.key].some(paragraph => paragraph.trim().length > 0));
}

/** Production may show the block only when all four reports exist and at least one shows the hard truth. */
export function allSamplesReady(reports: readonly SampleReport[] = SAMPLE_REPORTS) {
  return reports.every(sampleReady) && reports.some(report => report.showsHardTruth);
}
