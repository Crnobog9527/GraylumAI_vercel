import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/(zh-hans)/landing/preview/n/page';
import { J_NOTE_ANSWERS, J_NOTE_HEADS, J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { K_CTA } from '@/lib/landing/landing-copy-k';
import { L_CARE, L_COMPARE_NEXT, L_COMPARE_TITLE, L_HERO_FLOW, L_NOTE_REGIONS, L_OPS, L_REPORTS } from '@/lib/landing/landing-copy-l';
import { RISK_REVERSAL } from '@/lib/landing/landing-copy';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { SampleN } from './SampleN';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const plans = [plan('pro', 29, 279), plan('gold', 69, 621)];
const data = buildLandingPageData(ALL_ON, plans);
const render = (flags: LandingFlags = ALL_ON, showSamples = true) => renderToStaticMarkup(createElement(SampleN, {
  data: buildLandingPageData(flags, plans),
  siteName: 'Graylum', extras: { flags, showSamples }, membershipHref: '/auth?next=/profile',
}));
const between = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to));
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('style sample N (direction E, the bento grid, Owner 2026-10-17)', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe('Graylum 风格样稿 N');
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('n')).toBe(true);
  });

  it('keeps sample L\'s order: first screen, voices, operations, samples, worries, comparison, price, plans, FAQ, close', () => {
    const html = render();
    const order = ['id="hero-title"', 'id="voice-title"', 'id="ops-title"', 'id="samples-title"', 'id="care-title"',
      'id="compare-title"', 'id="pricing-title"', 'data-region="会员方案"', 'id="faq-title"', 'id="final-title"'].map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('不公开的风格样稿（N：便当格）');
  });

  it('is all light: the comparison sits on the light band, no dark band anywhere', () => {
    const html = render();
    expect(html).not.toContain('data-band="ink"');
    expect(html).toContain('data-zone="compare" data-band="tint"');
  });

  it('says on the first screen what it is, for whom and what you get, each coach line behind its flag', () => {
    const html = render();
    const hero = between(html, 'id="hero-title"', 'id="voice-title"');
    for (const part of [L_HERO_FLOW.youSay.text, L_HERO_FLOW.youGet.text, '免费和教练聊聊']) expect(hero).toContain(part);
    for (const item of L_HERO_FLOW.coachDoes.items) expect(render()).toContain(item.text);
  });

  it('only repeats facts the page already says: 24 hours from the p1 answer, the number of sample reports', () => {
    const hero = between(render(), 'id="hero-title"', 'id="voice-title"');
    expect(J_NOTE_ANSWERS.p1).toContain('AI 教练 24 小时在线');
    expect(text(hero)).toContain('24 小时在线');
    expect(text(hero)).toContain(`${L_REPORTS.length}种人拿到的完整报告`);
    expect(between(render(ALL_ON, false), 'id="hero-title"', 'id="voice-title"')).not.toContain('种人拿到的完整报告');
  });

  it('shows every voice as a cell with its region, its source and the coach\'s answer', () => {
    const wall = between(render(), 'id="voice-title"', 'id="ops-title"');
    expect(data.notes.length).toBeGreaterThan(0);
    for (const note of data.notes) {
      expect(wall).toContain(L_NOTE_REGIONS[note.id]);
      expect(wall).toContain(escape(J_NOTE_HEADS[note.id] ?? '教练怎么做'));
    }
    // The first cell is the Owner's opening note, and the frame's key cell.
    expect(wall.indexOf('data-key=""')).toBeLessThan(wall.indexOf(escape(data.notes.find(note => note.id === 'p7')?.quote ?? '')));
  });

  it('plays the week as L\'s carousel in a big cell: one tab per step, ONE window, the line and the close beside it', () => {
    const ops = between(render(), 'id="ops-title"', 'id="samples-title"');
    for (const part of [L_OPS.lede, L_OPS.close, K_CTA, escape(L_OPS.steps[0].line)]) expect(ops).toContain(part);
    expect((ops.match(/role="tab"/g) ?? []).length).toBe(L_OPS.steps.length);
    for (const step of L_OPS.steps) expect(ops).toContain(step.label);
    // One chat window: the first step's conversation, not the others'.
    expect((ops.match(/inert=""/g) ?? []).length).toBe(1);
    expect(ops).toContain(escape(L_OPS.steps[0].lines[0].text));
    expect(ops).not.toContain(escape(L_OPS.steps[1].lines[0].text));
    // The frame's key cell is the big cell holding the steps and the window.
    expect(ops.indexOf('data-key=""')).toBeLessThan(ops.indexOf('role="tablist"'));
  });

  it('carries all 14 sample reports as cells that open in the dialog, and hides them unless shown', () => {
    const html = render();
    expect(L_REPORTS.length).toBe(14);
    for (const report of L_REPORTS) expect(html).toContain(`<b>${escape(report.who)}</b>${escape(report.platform)}`);
    expect(html).toContain('<dialog');
    expect(render(ALL_ON, false)).not.toContain('id="samples-title"');
  });

  it('lists every worry behind its flag, voice first, and puts a button by them', () => {
    const care = between(render(), 'id="care-title"', 'id="compare-title"');
    for (const item of L_CARE.items) expect(care).toContain(escape(item.does));
    expect(care.indexOf(L_CARE.items[0].worry)).toBeLessThan(care.indexOf(L_CARE.items[1].worry));
    expect(care).toContain(K_CTA);
  });

  it('keeps the comparison\'s title and next steps', () => {
    const html = render();
    const at = html.indexOf('id="compare-title"');
    expect(text(html.slice(at, html.indexOf('</h2>', at)))).toContain(L_COMPARE_TITLE);
    for (const line of Object.values(L_COMPARE_NEXT)) expect(text(html)).toContain(line);
  });

  it('prices like sample L, then the plans: Gold recommended with 先聊后买 right under the cards', () => {
    const html = render();
    const price = between(html, 'id="pricing-title"', 'id="faq-title"');
    for (const part of [J_PRICE_TOTAL.text, 'Graylum AI：$29/月起', J_PRICE.more]) expect(price).toContain(part);
    expect(price).not.toContain(J_PRICE.checked);
    expect(price).toMatch(/data-plan="gold" data-recommended="true"/);
    expect(price).not.toMatch(/data-plan="pro" data-recommended/);
    const risk = price.indexOf(`data-region="${RISK_REVERSAL.title}"`);
    expect(risk).toBeGreaterThan(price.lastIndexOf('data-plan='));
    expect(price).toContain(RISK_REVERSAL.title);
  });

  it('has a button at least every two regions', () => {
    const html = render();
    const marks = ['id="hero-title"', 'id="voice-title"', 'id="ops-title"', 'id="samples-title"', 'id="care-title"',
      'id="compare-title"', 'id="pricing-title"', 'id="faq-title"', 'id="final-title"', '</main>'];
    const regions = marks.slice(0, -1).map((mark, index) => between(html, mark, marks[index + 1]));
    const hasButton = regions.map(region => region.includes(K_CTA) || region.includes('免费开始聊') || region.includes('data-plan='));
    for (let index = 0; index + 1 < hasButton.length; index += 1) expect(hasButton[index] || hasButton[index + 1]).toBe(true);
  });

  it('never claims to be the first, the only or the world\'s first', () => {
    const main = render().split('<main')[1];
    for (const word of ['全球首个', '首个', '唯一', '全球第一', '业内第一', '第一家']) expect(main).not.toContain(word);
  });
});
