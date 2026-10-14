import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'display-font', className: 'display-font' }) }));

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/h/page';
import { SCENES } from '@/components/landing/preview-g/scenes';
import { TILT_MAX, tiltFor } from '@/components/public-site/motion/DepthStage';
import { DigitRoll, splitUnits } from '@/components/public-site/motion/depth-text';
import { FINAL_ACTION, HERO, HERO_H, HOW_IT_WORKS, PRICE_COMPARE, VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { FLOW_STEPS } from '@/lib/landing/landing-flow';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { isPaletteId, PALETTES } from './PaletteSwitchH';
import { SampleH } from './SampleH';
import { charDelay, sceneTimeline } from './scene-timing';

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;

function render(flags: LandingFlags) {
  const data = buildLandingPageData(flags, [plan('pro', 29, 279), plan('gold', 69, 621)]);
  return { data, html: renderToStaticMarkup(createElement(SampleH, { data, siteName: 'Graylum', membershipHref: '/profile' })) };
}

describe('style sample H', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('h')).toBe(true);
    expect(APP_SEGMENTS.has('i')).toBe(true);
  });

  it('keeps the final copy, the six sections in order and one H1, readable without JavaScript', () => {
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
    // The Owner's first-screen pitch (2026-10-14), verbatim, and one CTA note on both buttons without the credits.
    for (const copy of Object.values(HERO_H)) expect(html).toContain(escape(copy));
    expect(html.split(HERO_H.ctaNote)).toHaveLength(3);
    const hero = html.slice(html.indexOf('<section aria-labelledby="hero-title"'), html.indexOf('</section>'));
    expect(hero).not.toContain('500 积分');
    expect(hero).not.toContain('随时能看、能导出，不会收回');
    expect(html).toContain('aria-label="Pro"');
    expect(html).toContain('aria-label="Gold"');
    expect(html).toContain('id="how-it-works"');
    expect(html).toContain('data-testid="aurora-backdrop"');
    // The palette switch renders with the first palette chosen; the page itself carries no palette attribute yet.
    expect(html).toContain('aria-label="配色方案（样稿对比用）"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).not.toContain('data-palette=');
    // Motion is switched on by script only; the server HTML is the finished state.
    expect(html).not.toContain('data-motion');
    expect(html).not.toContain('data-play');
  });

  it('shows every step as a selectable conversation with its verbatim title, demo line and note', () => {
    const { html } = render(ALL_ON);
    for (const step of FLOW_STEPS) {
      expect(html).toContain(`id="h-${step.id}-tab"`);
      expect(html).toContain(`id="h-${step.id}-panel"`);
      expect(html).toContain(escape(step.title));
      expect(html).toContain(escape(step.demo));
      expect(html).toContain(escape(step.note));
    }
    expect(html.match(/role="tabpanel"[^>]*hidden=""/g)).toHaveLength(FLOW_STEPS.length - 1);
    for (const line of SCENES[0].lines) expect(html).toContain(escape(line.text));
  });

  it('hides the scenes of switched-off capabilities with their steps', () => {
    const { html } = render({ ...ALL_ON, publish: false });
    expect(html).not.toContain('id="h-step-publish-tab"');
    expect(html).not.toContain('id="h-step-review-tab"');
    expect(html).toContain('id="h-step-chat-tab"');
  });
});

describe('sample H palettes', () => {
  it('offers three palettes and accepts only their ids', () => {
    expect(PALETTES.map(palette => palette.id)).toEqual(['ivory', 'graphite', 'gold']);
    expect(isPaletteId('graphite')).toBe(true);
    expect(isPaletteId('rainbow')).toBe(false);
    expect(isPaletteId(null)).toBe(false);
  });
});

describe('sample H motion helpers', () => {
  it('splits CJK per character and keeps Latin words and spaces whole', () => {
    expect(splitUnits('你的 AI 教练')).toEqual(['你', '的', ' ', 'AI', ' ', '教', '练']);
    expect(splitUnits('$1,299.50').join('')).toBe('$1,299.50');
  });

  it('rolls each digit to its final value in the server HTML and reads the value once', () => {
    const html = renderToStaticMarkup(createElement(DigitRoll, { value: '$29' }));
    expect(html).toContain('<span class="sr-only">$29</span>');
    expect(html.match(/--n:2/g)).toHaveLength(1);
    expect(html.match(/--n:9/g)).toHaveLength(1);
  });

  it('leans a card toward the pointer within the limit', () => {
    const rect = { left: 0, top: 0, width: 200, height: 100 };
    expect(tiltFor(100, 50, rect)).toEqual({ rx: 0, ry: 0, gx: 50, gy: 50 });
    expect(tiltFor(200, 0, rect)).toMatchObject({ rx: TILT_MAX, ry: TILT_MAX });
    expect(tiltFor(-50, 500, rect)).toMatchObject({ rx: -TILT_MAX, ry: -TILT_MAX });
  });

  it('plays every scene in order, with a reply typed after its dots and its card after the text', () => {
    expect(charDelay(0)).toBe(0);
    expect(charDelay(10)).toBe(26);
    expect(charDelay(1000)).toBe(8);
    for (const scene of SCENES) {
      const { timings, total } = sceneTimeline(scene.lines);
      expect(timings).toHaveLength(scene.lines.length);
      timings.forEach((timing, index) => {
        if (index > 0) expect(timing.appear).toBeGreaterThan(timings[index - 1].appear);
        expect(timing.typeStart).toBeGreaterThanOrEqual(timing.appear);
        if (timing.cardAt !== null) expect(timing.cardAt).toBeGreaterThan(timing.typeStart);
      });
      // A scene plays out in well under ten seconds.
      expect(total).toBeLessThan(10000);
    }
  });
});
