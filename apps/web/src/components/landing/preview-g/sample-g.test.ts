import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'display-font', className: 'display-font' }) }));

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/g/page';
import { pageProgress } from '@/components/public-site/motion/ScrollBackdrop';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { FLOW_STEPS } from '@/lib/landing/landing-flow';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SampleG } from './SampleG';
import { SCENES } from './scenes';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

function render(flags: LandingFlags) {
  const data = buildLandingPageData(flags, [plan('pro', 29, 279), plan('gold', 69, 621)]);
  return { data, html: renderToStaticMarkup(createElement(SampleG, { data, siteName: 'Graylum', membershipHref: '/app/profile' })) };
}

describe('style sample G', () => {
  it('is never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
  });

  it('keeps the final copy, the six sections in order and one H1', () => {
    const { data, html } = render(ALL_ON);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const text = html.slice(html.indexOf('<main')).replace(/<[^>]+>/g, '');
    const order = [HERO.title, VOICE_WALL.title, HOW_IT_WORKS.title, PRICE_COMPARE.title, LANDING_FAQ_TITLE, FINAL_ACTION.title]
      .map(title => text.indexOf(title));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const copy of [HERO.promise, HERO.primaryCta, HERO.secondaryCta, ...data.notes.map(note => note.answer)]) {
      expect(html).toContain(escape(copy));
    }
    expect(html).toContain('aria-label="Pro"');
    expect(html).toContain('aria-label="Gold"');
    expect(html).toContain('id="how-it-works"');
    expect(html).toContain('data-testid="scroll-backdrop"');
  });

  it('shows every step as a selectable conversation with its verbatim title, demo line and note', () => {
    const { html } = render(ALL_ON);
    expect(html.match(/role="tab"/g)?.length).toBeGreaterThanOrEqual(FLOW_STEPS.length);
    for (const step of FLOW_STEPS) {
      expect(html).toContain(`id="g-${step.id}-tab"`);
      expect(html).toContain(`id="g-${step.id}-panel"`);
      expect(html).toContain(escape(step.title));
      expect(html).toContain(escape(step.demo));
      expect(html).toContain(escape(step.note));
    }
    // Only the first scene is open in the server HTML; the others are in the page but hidden.
    expect(html.match(/role="tabpanel"[^>]*hidden=""/g)).toHaveLength(FLOW_STEPS.length - 1);
  });

  it('has a script for every step and invents no numbers', () => {
    expect(SCENES.map(scene => scene.id).sort()).toEqual(FLOW_STEPS.map(step => step.id).sort());
    for (const scene of SCENES) {
      expect(scene.lines.length).toBeGreaterThan(0);
      // Only step ordinals, "3–5 picks", week numbers and "30 days" may appear; no metrics or money.
      const words = JSON.stringify(scene.lines);
      expect(words).not.toMatch(/\d+(\.\d+)?\s*(%|万|k|K|\$|美元|元|粉|播放|次)/);
    }
  });

  it('shows every scene with its step: no capability is a switch (Owner 2026-10-17)', () => {
    const { html } = render(ALL_ON);
    for (const id of ['publish', 'review', 'chat']) expect(html).toContain(`id="g-step-${id}-tab"`);
  });
});

describe('ScrollBackdrop progress', () => {
  it('runs from 0 at the top to 1 at the bottom and stays inside that range', () => {
    expect(pageProgress(0, 5000, 1000)).toBe(0);
    expect(pageProgress(2000, 5000, 1000)).toBe(0.5);
    expect(pageProgress(4000, 5000, 1000)).toBe(1);
    expect(pageProgress(9000, 5000, 1000)).toBe(1);
    expect(pageProgress(-50, 5000, 1000)).toBe(0);
    expect(pageProgress(100, 800, 1000)).toBe(0);
  });
});
