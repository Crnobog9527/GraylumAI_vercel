import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/f/page';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { countTo } from './CountUp';
import { SampleF } from './SampleF';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

const render = () => renderToStaticMarkup(createElement(SampleF, {
  data: buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]), siteName: 'Graylum', membershipHref: '/app/profile',
}));

describe('style sample F', () => {
  it('is never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
  });

  it('keeps the six sections in the fixed order with the final copy and one H1', () => {
    const html = render();
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const order = [HERO.title, VOICE_WALL.title, HOW_IT_WORKS.title, PRICE_COMPARE.title, LANDING_FAQ_TITLE, FINAL_ACTION.title]
      .map(title => html.indexOf(`>${title}</h`));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const text of [HERO.promise, HERO.primaryCta, HERO.secondaryCta, RISK_REVERSAL.title, ...FINAL_ACTION.paths]) {
      expect(html).toContain(text);
    }
    for (const row of PRICE_COMPARE.rows) expect(html).toContain(row.price);
    expect(html).toContain('id="how-it-works"');
    expect(html).toContain('aria-label="Pro"');
  });

  it('rolls price numbers up and ends on the exact text', () => {
    const text = PRICE_COMPARE.rows[0].price;
    expect(countTo(text, 1)).toBe(text);
    expect(countTo('$2,000–10,000/月（2024 年调查平均 $2,107）', 0)).toBe('$0–0/月（2024 年调查平均 $0）');
  });
});
