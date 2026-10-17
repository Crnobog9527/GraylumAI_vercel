/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { FAQ_PAGE, faqGroups } from '@/lib/seo/content/faq';
import { LANDING_FAQ } from '@/lib/landing/landing-faq';
import { PUBLIC_PAGES } from '@/lib/seo/public-pages';
import { FaqPage } from './FaqPage';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const cjk = (text: string) => (text.match(/[㐀-鿿]/g) ?? []).length;
const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

it('shows the landing FAQ with one H1, and the FAQPage data matches the visible questions and answers', () => {
  const html = renderToStaticMarkup(<FaqPage />);
  expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  const data = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
  const faq = data.find((item: { '@type': string }) => item['@type'] === 'FAQPage');
  const groups = faqGroups();
  const items = groups.flatMap(group => group.items);
  expect(faq.mainEntity.map((entry: { name: string }) => entry.name)).toEqual(items.map(item => item.question));
  const text = decode(html);
  for (const item of items) {
    expect(text).toContain(item.question);
    for (const paragraph of item.answer) expect(text).toContain(paragraph);
  }
  // Founder answers need the live seat count: never on this static page or in its data.
  expect(items.some(item => item.needs.includes('founder'))).toBe(false);
  expect(items.length).toBeLessThan(LANDING_FAQ.flatMap(group => group.items).length);
  expect(groups.map(group => group.title)).toEqual(['关于教练', '关于我适不适合', '关于付费和账号'].slice(0, groups.length));
});

it('keeps the metadata within the spec limits and is in the sitemap', () => {
  expect(cjk(FAQ_PAGE.metaTitle)).toBeLessThanOrEqual(30);
  expect(cjk(FAQ_PAGE.metaDescription)).toBeGreaterThanOrEqual(60);
  expect(cjk(FAQ_PAGE.metaDescription)).toBeLessThanOrEqual(80);
  expect(FAQ_PAGE.lead.length).toBeLessThanOrEqual(100);
  expect(PUBLIC_PAGES.some(page => page.path === '/faq')).toBe(true);
});
