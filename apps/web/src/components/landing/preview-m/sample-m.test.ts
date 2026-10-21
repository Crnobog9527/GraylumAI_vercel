import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/(zh-hans)/landing/preview/m/page';
import { RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { L_CARE, L_COMPARE_NEXT, L_HERO_FLOW, L_NOTE_REGIONS, L_OPS, L_REPORTS } from '@/lib/landing/landing-copy-l';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { SampleM } from './SampleM';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
const render = (flags: LandingFlags = ALL_ON, showSamples = true) => renderToStaticMarkup(createElement(SampleM, {
  data, siteName: 'Graylum', extras: { flags, showSamples }, membershipHref: '/app/profile?tab=subscription',
}));
const between = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to));

describe('style sample M (direction H, product-led, Owner 2026-10-17)', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('m')).toBe(true);
  });

  it('keeps sample L\'s order: first screen, voices, operations, samples, worries, comparison, price, FAQ, close', () => {
    const html = render();
    const order = ['id="hero-title"', 'id="voice-title"', 'id="ops-title"', 'id="samples-title"', 'id="care-title"',
      'id="compare-title"', 'id="pricing-title"', 'id="faq-title"', 'id="final-title"'].map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('says on the first screen what you say, what the coach does (each line behind its flag) and what you get', () => {
    const hero = between(render(), 'id="hero-title"', 'id="voice-title"');
    for (const text of [L_HERO_FLOW.youSay.text, L_HERO_FLOW.youGet.text]) expect(hero).toContain(text);
    // The positioning conversation (the week window's first stage) is there for phones.
    expect(hero).toContain(escape(J_WEEK.lines[0].text));
    for (const item of L_HERO_FLOW.coachDoes.items) expect(render()).toContain(item.text);
  });

  it('shows every voice note, unfolded, with its region', () => {
    const wall = between(render(), 'id="voice-title"', 'id="ops-title"');
    for (const note of data.notes) {
      expect(wall).toContain(L_NOTE_REGIONS[note.id]);
      expect(wall).toContain(escape(note.quote).replace(/'/g, '&#x27;'));
    }
    expect(data.notes.length).toBe(VOICE_WALL.notes.length);
    expect(wall).not.toContain('看另外');
  });

  it('tells region 3 as sample L\'s week: lede, close, every step as a tab, the first step\'s conversation in the HTML', () => {
    const ops = between(render(), 'id="ops-title"', 'id="samples-title"');
    for (const text of [L_OPS.lede, L_OPS.close]) expect(ops).toContain(text);
    expect((ops.match(/role="tab"/g) ?? []).length).toBe(L_OPS.steps.length);
    for (const step of L_OPS.steps) expect(ops).toContain(step.label);
    expect(ops).toContain(escape(L_OPS.steps[0].lines[0].text));
  });

  it('moves all 14 sample reports as cards (only when the preview or the flag shows them)', () => {
    const html = render();
    expect(L_REPORTS.length).toBe(14);
    for (const report of L_REPORTS) expect(html).toContain(`<b>${escape(report.who)}</b>${escape(report.platform)}`);
    expect(render(ALL_ON, false)).not.toContain('id="samples-title"');
  });

  it('lists the worries as sample L does, each behind its flag', () => {
    const care = between(render(), 'id="care-title"', 'id="compare-title"');
    for (const item of L_CARE.items) expect(care).toContain(item.worry);
  });

  it('sets the comparison on the light band (no dark block) and ends each pair on what to do next', () => {
    const html = render();
    expect(html).not.toContain('data-band="ink"');
    expect(html).toContain('data-band="tint" data-region="对比区"');
    const text = html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    for (const line of Object.values(L_COMPARE_NEXT)) expect(text).toContain(line);
  });

  it('prices as sample L (whole usual total) and adds the plan cards: Gold recommended, "先聊后买" right under them', () => {
    const html = render();
    expect(html).toContain(J_PRICE_TOTAL.text);
    const plans = between(html, 'data-region="会员方案"', 'id="faq-title"');
    expect(plans).toMatch(/data-plan="gold" data-recommended="true"/);
    expect(plans).not.toMatch(/data-plan="pro" data-recommended/);
    expect(plans).toContain(RISK_REVERSAL.title);
    for (const point of data.risk) expect(plans).toContain(point.text);
    expect(plans).toContain('href="/app/profile?tab=subscription"');
  });

  it('has the thin sticky button bar and a button at least every two regions', () => {
    const html = render();
    expect(html).toContain(L_OPS.lede);
    const regions = ['hero-title', 'voice-title', 'ops-title', 'samples-title', 'care-title', 'compare-title', 'pricing-title',
      'faq-title', 'final-title'].map(id => html.indexOf(`id="${id}"`));
    const labels = ['免费和教练聊聊', J_PRICE.more, ...data.pricing.cards.map(card => card.cta)];
    const buttons = labels.flatMap(label => [...html.matchAll(new RegExp(label, 'g'))].map(match => match.index ?? 0));
    const hasButton = (from: number, to: number) => buttons.some(at => at > from && at < to);
    for (let index = 0; index + 2 < regions.length; index += 1) {
      expect(hasButton(regions[index], regions[index + 2])).toBe(true);
    }
  });

  it('never claims to be the first, the only or the world\'s first', () => {
    const main = render().split('<main')[1];
    for (const word of ['全球首个', '首个', '唯一', '全球第一', '业内第一', '第一家']) expect(main).not.toContain(word);
  });
});
