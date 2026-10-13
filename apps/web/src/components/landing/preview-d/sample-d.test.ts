import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'display-font', className: 'display-font' }) }));

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/d/page';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { FLOW_STEPS } from '@/lib/landing/landing-flow';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { DISPLAY_TEXTS, SUBSET_TEXT } from './display-glyphs';
import { SampleD } from './SampleD';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

describe('style sample D', () => {
  it('is never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
  });

  it('keeps the final copy, the six sections in order and one H1', () => {
    const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
    const html = renderToStaticMarkup(createElement(SampleD, { data, siteName: 'Graylum', membershipHref: '/profile' }));
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const order = [HERO.title, VOICE_WALL.title, HOW_IT_WORKS.title, PRICE_COMPARE.title, LANDING_FAQ_TITLE, FINAL_ACTION.title]
      .map(title => html.indexOf(`>${title}</h`));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const text of [HERO.promise, HERO.primaryCta, HERO.secondaryCta, ...data.notes.map(note => note.answer)]) {
      expect(html).toContain(escape(text));
    }
    for (const step of FLOW_STEPS) {
      expect(html).toContain(escape(step.title));
      expect(html).toContain(escape(step.note));
    }
    expect(html).toContain('aria-label="Pro"');
    expect(html).toContain('aria-label="Gold"');
    expect(html).toContain('id="how-it-works"');
  });

  it('has every heading character in the display font subset', () => {
    const missing = new Set([...DISPLAY_TEXTS.join('')].filter(char => !SUBSET_TEXT.includes(char)));
    expect([...missing]).toEqual([]);
  });
});
