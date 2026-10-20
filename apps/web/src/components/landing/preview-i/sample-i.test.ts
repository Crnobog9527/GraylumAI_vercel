import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/(zh-hans)/landing/preview/i/page';
import { FINAL_ACTION, HERO, HOW_IT_WORKS, PRICE_COMPARE, VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { FLOW_STEPS } from '@/lib/landing/landing-flow';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SCENES } from '@/components/landing/preview-g/scenes';
import { SampleI } from './SampleI';
import { nextPlayback, startLine, type Playback } from './use-scene-playback';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

function render(flags: LandingFlags) {
  const data = buildLandingPageData(flags, [plan('pro', 29, 279), plan('gold', 69, 621)]);
  return { data, html: renderToStaticMarkup(createElement(SampleI, { data, siteName: 'Graylum', membershipHref: '/app/profile' })) };
}

describe('style sample I', () => {
  it('is never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
  });

  it('keeps the final copy, the six sections in order, one H1 and the story backdrop', () => {
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
    expect(html).toContain('data-testid="i-story-backdrop"');
  });

  it('shows every step as a selectable conversation with its verbatim title, demo line, note and full script', () => {
    const { html } = render(ALL_ON);
    for (const step of FLOW_STEPS) {
      expect(html).toContain(`id="i-${step.id}-tab"`);
      expect(html).toContain(`id="i-${step.id}-panel"`);
      expect(html).toContain(escape(step.title));
      expect(html).toContain(escape(step.demo));
      expect(html).toContain(escape(step.note));
    }
    // Without JavaScript every line is drawn in full; none is left pending or half typed.
    for (const line of SCENES.flatMap(scene => scene.lines)) expect(html).toContain(escape(line.text));
    expect(html).not.toContain('data-state="pending"');
    expect(html.match(/role="tabpanel"[^>]*hidden=""/g)).toHaveLength(FLOW_STEPS.length - 1);
  });

  it('shows every scene with its step: no capability is a switch (Owner 2026-10-17)', () => {
    const { html } = render(ALL_ON);
    for (const id of ['publish', 'review', 'chat']) expect(html).toContain(`id="i-step-${id}-tab"`);
  });
});

describe('scene playback', () => {
  const lines = [
    { role: 'coach' as const, text: 'abcde', card: { type: 'chips' } },
    { role: 'user' as const, text: 'ok' },
  ];

  it('thinks, types, shows the card, then the next line, then ends showing everything', () => {
    const seen: Playback[] = [];
    let step = startLine(lines, 0);
    while (step.state) {
      seen.push(step.state);
      expect(step.wait).toBeGreaterThan(0);
      step = nextPlayback(lines, step.state);
    }
    expect(seen.map(state => state && `${state.index}:${state.phase}:${state.chars}`)).toEqual([
      '0:thinking:0', '0:typing:0', '0:typing:2', '0:typing:4', '0:card:5', '1:shown:2',
    ]);
    expect(step.state).toBeNull();
  });

  it('finishes at once for an empty script', () => {
    expect(startLine([], 0).state).toBeNull();
  });
});
