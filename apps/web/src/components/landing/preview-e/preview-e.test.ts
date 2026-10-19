import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/e/page';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { PreviewE } from './PreviewE';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
// renderToStaticMarkup escapes quotes and ampersands in text.
const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

function render(flags: LandingFlags) {
  const data = buildLandingPageData(flags, [plan('pro', 29, 279), plan('gold', 69, 621)]);
  return { data, html: renderToStaticMarkup(createElement(PreviewE, { data, siteName: 'Graylum', membershipHref: '/profile' })) };
}

describe('style sample E', () => {
  it('is never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
  });

  it('keeps the six modules in the fixed order with the final copy and one H1', () => {
    const { data, html } = render(ALL_ON);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const order = [HERO.title, VOICE_WALL.title, HOW_IT_WORKS.title, PRICE_COMPARE.title, LANDING_FAQ_TITLE, FINAL_ACTION.title];
    const positions = order.map(text => html.indexOf(`>${text}</h`));
    expect(positions.every(position => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const text of [HERO.promise, HERO.primaryCta, HERO.secondaryCta, VOICE_WALL.lede, RISK_REVERSAL.title, FINAL_ACTION.cta,
      data.heroNote, data.finalNote, data.promise.map(part => part.text).join(''), ...FINAL_ACTION.paths]) {
      expect(html).toContain(escaped(text));
    }
    for (const note of data.notes) expect(html).toContain(escaped(note.answer));
    for (const step of data.flowSteps) for (const text of [step.title, step.demo, step.note]) expect(html).toContain(escaped(text));
    for (const group of data.faqGroups) for (const item of group.items) expect(html).toContain(escaped(item.question));
    expect(html).toContain('aria-label="Pro"');
    expect(html).toContain('aria-label="Gold"');
    expect(html).toContain('id="how-it-works"');
  });

  it('shows every capability\'s blocks: no capability is a switch (Owner 2026-10-17)', () => {
    const { html } = render(ALL_ON);
    expect(html).toContain('看复盘');
    expect(html).toContain('TikTok');
  });
});
