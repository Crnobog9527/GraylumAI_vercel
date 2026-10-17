/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { resolveLandingFlags, visibleItems } from '@/lib/landing/landing-flags';
import { faqAnswerText, LANDING_FAQ, type LandingFaqGroup } from '@/lib/landing/landing-faq';

// /faq shows the landing page's own FAQ (Owner's final offer 2026-10-13; `lib/landing/landing-faq.ts` stays the single
// source, nothing is written twice). The founder answers depend on the live seat count the landing page reads from the
// server, which a statically built page cannot show, so they stay on the landing page only; the FAQPage data below is
// built from exactly the groups the page renders.
export const FAQ_PAGE = {
  path: '/faq',
  metaTitle: '常见问题：AI 教练、适不适合你、付费和账号',
  metaDescription: '关于 AI 教练怎么用、你适不适合、付费和账号怎么处理，这里集中回答新用户最常问的问题。没做过账号、不懂运营也能用，所有答案都只按已有的功能来写。',
  h1: 'Graylum 常见问题',
  lead: '这里回答新用户最常问的问题：AI 教练是什么、适不适合你，以及付费和账号怎么处理。',
  updated: '2026-10-18',
  breadcrumb: [{ name: '首页', path: '/' }, { name: '常见问题', path: '/faq' }],
};

export function faqGroups(): LandingFaqGroup[] {
  const flags = { ...resolveLandingFlags(), founder: false };
  return LANDING_FAQ
    .map(group => ({ ...group, items: visibleItems(flags, group.items) }))
    .filter(group => group.items.length > 0);
}

export function faqEntries(groups: readonly LandingFaqGroup[] = faqGroups()) {
  return groups.flatMap(group => group.items.map(item => ({ question: item.question, answer: faqAnswerText(item) })));
}
