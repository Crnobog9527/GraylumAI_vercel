import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata, generateStaticParams } from '@/app/landing/preview/[variant]/page';
import { HERO, HOW_IT_WORKS, PRICE_COMPARE } from '@/lib/landing/landing-copy';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { PreviewPage } from './PreviewPage';
import { PREVIEW_VARIANTS } from './variants';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

describe('style sample pages', () => {
  it('are never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(generateStaticParams()).toEqual(PREVIEW_VARIANTS.map(variant => ({ variant: variant.id })));
  });

  it.each(PREVIEW_VARIANTS.map(variant => variant.id))('sample %s keeps the final copy, one H1 and the price cards', variant => {
    const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
    const html = renderToStaticMarkup(createElement(PreviewPage, { variant, data, siteName: 'Graylum', membershipHref: '/profile' }));
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    for (const text of [HERO.title, HERO.promise, HERO.primaryCta, HERO.secondaryCta, HOW_IT_WORKS.title, PRICE_COMPARE.title]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('aria-label="Pro"');
    expect(html).toContain('aria-label="Gold"');
    expect(html).toContain('id="how-it-works"');
  });
});
