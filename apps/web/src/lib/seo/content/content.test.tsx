import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ArticlePage } from '@/components/public-site/ArticlePage';
import { SITE_CHROME } from '@/components/public-site/site-chrome';
import type { ArticleContent } from '../article';
import { PUBLIC_PAGES } from '../public-pages';
import { ABOUT_ZH_HANS, ABOUT_ZH_TW } from './about';
import { ZH_TW_HUB } from './zh-tw/hub';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

// Every public content page; keyword pages are added here as they are written.
export const ARTICLES: ArticleContent[] = [ABOUT_ZH_HANS, ABOUT_ZH_TW, ZH_TW_HUB];

// Login entry pages are not in the sitemap but are real pages every visitor can open.
const LOGIN_LINKS = new Set(['/login', '/login?action=signup']);
const PAGE_PATHS = new Set(PUBLIC_PAGES.map(page => page.path));

// Characters that only exist in Simplified Chinese; Taiwan pages must not contain them (spec 3.1).
const SIMPLIFIED_ONLY = /[们这说个发为对时会过还进动么优网户页质视频账号运营信息设计应该经开关题见让从产业务认识讯书写读样实际点热准问]/;

function internalLinks(content: ArticleContent) {
  const chrome = SITE_CHROME[content.locale];
  return [
    content.cta.href,
    ...content.breadcrumb.map(item => item.path),
    ...content.related.map(link => link.href),
    ...Object.values(content.alternates ?? {}),
    chrome.home,
    ...chrome.nav.map(link => link.href),
    ...chrome.company.map(link => link.href),
    ...chrome.legal.map(link => link.href),
  ];
}

describe.each(ARTICLES.map(content => [content.path, content] as const))('public page %s', (_path, content) => {
  it('is in the sitemap and every internal link points at an existing public page', () => {
    expect(PAGE_PATHS.has(content.path)).toBe(true);
    for (const href of internalLinks(content)) {
      expect(PAGE_PATHS.has(href) || LOGIN_LINKS.has(href), href).toBe(true);
    }
  });

  it('keeps the title, description and first-screen answer within the spec limits', () => {
    const cjk = (text: string) => (text.match(/[㐀-鿿]/g) ?? []).length;
    expect(cjk(content.metaTitle)).toBeLessThanOrEqual(30);
    expect(cjk(content.metaDescription)).toBeGreaterThanOrEqual(45);
    expect(cjk(content.metaDescription)).toBeLessThanOrEqual(85);
    expect(content.lead.length).toBeLessThanOrEqual(110);
    expect(content.sections.length).toBeGreaterThanOrEqual(3);
    expect(content.sections.length).toBeLessThanOrEqual(6);
  });

  it('renders exactly one H1, a product entry, the visible FAQ as FAQPage data, and the page language', () => {
    const html = renderToStaticMarkup(<ArticlePage content={content} supportEmail="help@graylum.com" />);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain(`href="${content.cta.href}"`);
    expect(html).toContain(`lang="${content.locale === 'zh-TW' ? 'zh-Hant-TW' : 'zh-Hans'}"`);
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
    const faq = data.find((item: { '@type': string }) => item['@type'] === 'FAQPage');
    expect(faq?.mainEntity.map((item: { name: string }) => item.name)).toEqual(content.faq?.map(item => item.question));
    for (const item of content.faq ?? []) {
      expect(html).toContain(item.answer);
    }
    expect(html.match(/<h[1-6][\s>]/g)!.length).toBe(html.match(/<h[1-6][\s>]/g)!.filter(tag => !tag.startsWith('<h4')).length);
  });

  it.runIf(content.locale === 'zh-TW')('uses Traditional characters only', () => {
    const text = JSON.stringify(content) + JSON.stringify(SITE_CHROME['zh-TW']);
    expect(text.match(SIMPLIFIED_ONLY)?.[0]).toBeUndefined();
  });
});
