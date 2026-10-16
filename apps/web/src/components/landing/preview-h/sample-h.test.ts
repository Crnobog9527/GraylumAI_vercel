import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'display-font', className: 'display-font' }) }));

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/h/page';
import { SCENES } from '@/components/landing/preview-g/scenes';
import { TILT_MAX, tiltFor } from '@/components/public-site/motion/DepthStage';
import { DigitRoll, splitUnits } from '@/components/public-site/motion/depth-text';
import { FINAL_ACTION, H_COMPARE, HERO, HERO_H, HOW_IT_WORKS, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import { SIGNUP_CTA_HREF } from '@/lib/seo/content/shared';
import { LANDING_FAQ_TITLE } from '@/lib/landing/landing-faq';
import { FLOW_STEPS } from '@/lib/landing/landing-flow';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { audienceParts } from './ScreensH';
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
    for (const copy of [HERO.promise, HERO.primaryCta, ...data.notes.map(note => note.answer)]) {
      expect(html).toContain(escape(copy));
    }
    // The Owner's first-screen pitch (2026-10-14), verbatim, and one CTA note under every main button, without the credits.
    const shown = [HERO_H.audience, HERO_H.audienceSummary, HERO_H.difference, HERO_H.ctaNote];
    for (const copy of shown) expect(html).toContain(escape(copy));
    // First screen, end of module 3 and the close.
    expect(html.split(HERO_H.ctaNote)).toHaveLength(4);
    const hero = html.slice(html.indexOf('<section aria-labelledby="hero-title"'), html.indexOf('aria-labelledby="audience-title"'));
    // Option A: the first screen holds only the title, the promise, the button and its note (and the product).
    for (const copy of [HERO.title, HERO.promise, HERO.primaryCta, HERO_H.ctaNote]) expect(hero).toContain(escape(copy));
    for (const copy of [HERO_H.audienceSummary, HERO_H.difference]) expect(hero).not.toContain(escape(copy));
    // One idea per screen after it: who it is for, then why not a general AI with the Owner's comparison.
    const screens = [HERO_H.audienceSummary, HERO_H.difference, H_COMPARE.title].map(copy => html.indexOf(escape(copy)));
    expect(screens.every(index => index > 0)).toBe(true);
    expect([...screens].sort((a, b) => a - b)).toEqual(screens);
    for (const row of H_COMPARE.rows) for (const cell of [row.generic, row.coach]) expect(html).toContain(escape(cell));
    expect(hero).not.toContain('500 积分');
    expect(hero).not.toContain('随时能看、能导出，不会收回');
    expect(html).toContain('aria-label="Pro"');
    expect(html).toContain('aria-label="Gold"');
    expect(html).toContain('id="how-it-works"');
    // Motion is switched on by script only; the server HTML is the finished state.
    expect(html).not.toContain('data-motion');
    expect(html).not.toContain('data-play');
  });

  it('applies the diagnosis layout: no step cards on the first screen, anchors before plans, a button after module 3', () => {
    const { data, html } = render(ALL_ON);
    const hero = html.slice(html.indexOf('<section aria-labelledby="hero-title"'), html.indexOf('id="voice-title"'));
    for (const step of data.flowSteps.slice(0, 3)) expect(hero).not.toContain(escape(step.demo));
    const pricing = html.slice(html.indexOf('id="pricing"'));
    expect(pricing.indexOf(escape(PRICE_COMPARE.lede))).toBeLessThan(pricing.indexOf('aria-label="Pro"'));
    expect(pricing.indexOf('aria-label="Pro"')).toBeLessThan(pricing.indexOf(escape(RISK_REVERSAL.title)));
    const module3 = html.slice(html.indexOf('id="how-it-works"'), html.indexOf('id="pricing"'));
    expect(module3).toContain(`href="${escape(SIGNUP_CTA_HREF)}"`);
    for (const part of data.promise) expect(module3).toContain(`<li>${escape(part.text)}</li>`);
    // Only the first question starts open; every card of the voice wall is in the HTML.
    expect(html.slice(html.indexOf('id="faq"')).match(/<details[^>]* open=""/g)).toHaveLength(1);
    for (const note of data.notes) expect(html).toContain(escape(note.quote));
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

  it('keeps the weekly-review promise behind the publish flag, like the other needs-publish copy', () => {
    const review = HERO_H.differenceBody.find(part => part.text.includes('每周和你复盘'));
    expect(review?.needs).toContain('publish');
    expect(render(ALL_ON).data.differenceBody).toContain('每周和你复盘');
    const off = render({ ...ALL_ON, publish: false });
    expect(off.data.differenceBody).not.toContain('每周和你复盘');
    expect(off.data.differenceBody).toContain('Graylum AI 先了解你的情况');
    expect(off.html).not.toContain('每周和你复盘');
  });
});

describe('sample H first screen', () => {
  it('splits the audience line into four chips without changing a character', () => {
    const parts = audienceParts(HERO_H.audience);
    expect(parts).toHaveLength(4);
    expect(parts.join('')).toBe(HERO_H.audience);
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
