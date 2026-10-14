/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SAMPLE_SECTIONS } from './landing-samples';

/**
 * Sample J's four sample reports (Owner 2026-10-15), opening "AI 教练怎么接手你的运营": the finished result first, then
 * how it is made. The groups and platforms are the Owner's; the reports themselves come from the research window
 * after RT-7 and are not written here — until then each card shows "样例报告生成中" in the report's layout. Shown only
 * in a local development preview or when the landing flag `sampleReports` is on (off on staging and production).
 */
export const J_SAMPLES = {
  /** NEW */
  title: '先看成果：四种人拿到的样例报告',
  lede: '每份都是 AI 教练按同一套方法写出的完整报告。下面是三段节选，点开看全文。',
  pending: '样例报告生成中',
  more: '看完整报告',
  truthTag: '教练说真话',
  sections: SAMPLE_SECTIONS,
  reports: [
    { slug: 'accountant', who: '会计', platform: 'YouTube', truth: false },
    { slug: 'shop', who: '小店', platform: '小红书', truth: false },
    { slug: 'side-hustle', who: '好物副业', platform: 'TikTok', truth: false },
    { slug: 'student', who: '留学生', platform: 'Instagram', truth: true },
  ],
} as const;

export const samplePath = (slug: string) => `/landing/samples/${slug}`;
