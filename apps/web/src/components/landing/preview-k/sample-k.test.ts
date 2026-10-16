import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/k/page';
import { SampleJ } from '@/components/landing/preview-j/SampleJ';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { J_REPORT } from '@/lib/landing/landing-copy-j-takeover';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { K_CTA, K_GOLD_LINE, K_MOMENTS, K_PRICE_TERMS, K_RHYTHM, K_SAMPLES_BRIDGE } from '@/lib/landing/landing-copy-k';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { SampleK } from './SampleK';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
const render = (flags: LandingFlags = ALL_ON, showSamples = true) =>
  renderToStaticMarkup(createElement(SampleK, { data, siteName: 'Graylum', extras: { flags, showSamples } }));
const count = (html: string, text: string) => html.split(text).length - 1;

describe('style sample K (sample J slimmed down, Owner 2026-10-17)', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('k')).toBe(true);
  });

  it('runs the slimmed order: first screen, voices, three moments, samples, the week, comparison, price, FAQ, close', () => {
    const html = render();
    const order = ['id="hero-title"', 'id="voice-title"', 'id="moments-title"', 'id="samples-title"', 'id="rhythm-title"',
      'id="compare-title"', 'id="pricing-title"', 'id="faq-title"', 'id="final-title"'].map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Only regions 3 and 4 take the largest heading; one H1.
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('holds the first screen still (no stage buttons) and folds the voice wall after four', () => {
    const html = render();
    const hero = html.slice(html.indexOf('id="hero-title"'), html.indexOf('id="voice-title"'));
    expect(hero).not.toContain(J_WEEK.pickLabel);
    expect(hero).toContain(escape(J_WEEK.topics.items[0].title));
    expect(html).toContain('data-four="true"');
  });

  it('keeps product jargon out of everything before the moments', () => {
    const html = render();
    const before = html.slice(html.indexOf('<main'), html.indexOf('id="moments-title"'));
    for (const word of ['定位清单', '首席主笔', 'Gold', '积分', '评审团']) expect(before).not.toContain(word);
  });

  it('shows three key moments by click: no scroll-locked story, no jury, no report window', () => {
    const html = render();
    expect(count(html, 'role="tab"')).toBe(K_MOMENTS.length + J_SAMPLES.reports.length);
    for (const moment of K_MOMENTS) expect(html).toContain(escape(moment.note));
    expect(html).not.toContain(J_REPORT.juryEntry);
    expect(html).not.toContain('600svh');
    // A moment whose capability is off is gone.
    expect(render({ ...ALL_ON, research: false })).not.toContain(escape(K_MOMENTS[1].note));
  });

  it('shows the sample reports as 10-second cards only, after "换成你，会是这样", with the button', () => {
    const html = render();
    expect(html).toContain(K_SAMPLES_BRIDGE);
    expect(html).toContain(J_SAMPLES.glance.title);
    expect(html).not.toContain(J_SAMPLES.overview.title);
    expect(html).toContain(J_SAMPLES.full.open);
    // The first screen's button carries the same words; the reports and the comparison add one each.
    expect(count(html, K_CTA)).toBe(3);
    // Off on staging until the reports are live: then neither the block nor its button.
    const off = render(ALL_ON, false);
    expect(off).not.toContain(K_SAMPLES_BRIDGE);
    expect(count(off, K_CTA)).toBe(2);
  });

  it('turns the work into one row of the week, each item behind its capability', () => {
    const html = render();
    for (const item of K_RHYTHM) expect(html).toContain(item.text);
    const noPublish = render({ ...ALL_ON, publish: false });
    for (const item of K_RHYTHM) expect(noPublish.includes(item.text)).toBe(!item.needs.includes('publish'));
  });

  it('keeps two comparisons, the 穿搭博主 one first, in plain type', () => {
    const html = render();
    const compare = html.slice(html.indexOf('id="compare-title"'), html.indexOf('id="pricing-title"'));
    const shown = J_COMPARE.pairs.filter(pair => compare.includes(escape(pair.question)));
    expect(shown).toHaveLength(2);
    expect(shown[0].question).toContain('穿搭博主');
    expect(compare).not.toContain('inert');
  });

  it('keeps the struck total as it was and adds the terms and the Gold line under the price button', () => {
    const html = render();
    expect(html).toContain(J_PRICE_TOTAL.text);
    expect(html).toContain(`href="#${K_PRICE_TERMS.faqId}"`);
    expect(html).toContain(`id="${K_PRICE_TERMS.faqId}"`);
    expect(html).toContain(K_GOLD_LINE.text);
    expect(render({ ...ALL_ON, fusion: false })).not.toContain(K_GOLD_LINE.text);
  });

  it('leaves sample J as it was', () => {
    const j = renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', extras: { flags: ALL_ON, showSamples: true } }));
    expect(j).toContain(J_WEEK.pickLabel);
    expect(j).toContain(J_SAMPLES.overview.title);
    for (const mark of ['data-calm', 'data-four', K_SAMPLES_BRIDGE]) expect(j).not.toContain(mark);
  });
});
