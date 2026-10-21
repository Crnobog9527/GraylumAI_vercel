import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/(zh-hans)/landing/preview/o/page';
import { RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import { J_NOTE_ANSWERS } from '@/lib/landing/landing-copy-j';
import { L_CARE, L_COMPARE_NEXT, L_HERO_FLOW, L_NOTE_REGIONS, L_OPS, L_REPORTS } from '@/lib/landing/landing-copy-l';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { O_STATIONS, stepNotes } from './copy-o';
import { routePath } from './RouteO';
import { SampleO } from './SampleO';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
const render = (flags: LandingFlags = ALL_ON, showSamples = true) => renderToStaticMarkup(createElement(SampleO, {
  data, siteName: 'Graylum', extras: { flags, showSamples }, membershipHref: '/login?next=/profile',
}));
const between = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to));
const stations = (html: string) => [...html.matchAll(/data-station="([^"]+)"/g)].map(match => match[1]);

describe('style sample O (direction C, 路线图, Owner 2026-10-17)', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe('Graylum 风格样稿 O');
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('o')).toBe(true);
  });

  it('keeps sample L\'s order: first screen, voices, operations, samples, worries, comparison, price, plans, FAQ, close', () => {
    const html = render();
    const order = ['id="hero-title"', 'id="voice-title"', 'id="ops-title"', 'id="samples-title"', 'id="care-title"',
      'id="compare-title"', 'id="pricing-title"', 'data-region="会员方案"', 'id="faq-title"', 'id="final-title"'].map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('不公开的风格样稿（O：路线图）');
  });

  it('runs one route from station 0 to 10, every step of the week a station, the three named stops in place', () => {
    const html = render();
    expect(stations(html)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', O_STATIONS.end]);
    expect(between(html, 'id="voice-title"', 'id="ops-title"')).not.toContain(O_STATIONS.samples);
    expect(html.indexOf(O_STATIONS.voice)).toBeLessThan(html.indexOf('id="voice-title"'));
    expect(html.indexOf(O_STATIONS.samples)).toBeLessThan(html.indexOf('id="samples-title"'));
    expect(html.indexOf(O_STATIONS.price)).toBeLessThan(html.indexOf('data-region="会员方案"'));
    // Without the samples the close is still the end.
    expect(stations(render(ALL_ON, false)).at(-1)).toBe(O_STATIONS.end);
  });

  it('draws the route down through the stations and bows only long legs', () => {
    expect(routePath([{ x: 10, y: 0 }], 0)).toBe('');
    expect(routePath([{ x: 10, y: 0 }, { x: 10, y: 100 }], 20)).toBe('M10 0 C10 50 10 50 10 100');
    expect(routePath([{ x: 10, y: 0 }, { x: 10, y: 400 }], 20).match(/C/g)).toHaveLength(2);
  });

  it('shows sample L\'s first screen: you say → the coach does (each line behind its flag) → you get', () => {
    const hero = between(render(), 'id="hero-title"', 'id="voice-title"');
    for (const text of [L_HERO_FLOW.youSay.text, L_HERO_FLOW.youGet.text]) expect(hero).toContain(text);
    for (const item of L_HERO_FLOW.coachDoes.items) expect(render()).toContain(item.text);
  });

  it('shows every voice unfolded, with its region, source and the coach\'s answer', () => {
    const wall = between(render(), 'id="voice-title"', 'id="ops-title"');
    expect((wall.match(/data-region="心声卡片"/g) ?? []).length).toBe(data.notes.length);
    for (const note of data.notes) {
      expect(wall).toContain(escape(note.quote));
      expect(wall).toContain(L_NOTE_REGIONS[note.id]);
      if (J_NOTE_ANSWERS[note.id]) expect(wall).toContain(escape(J_NOTE_ANSWERS[note.id]));
    }
    if (data.notes.some(note => note.translated)) expect(wall).toContain(VOICE_WALL.translatedLabel);
  });

  it('tells region 3 as sample L\'s week, its first step\'s line pinned beside the real chat window', () => {
    const ops = between(render(), 'id="ops-title"', 'id="samples-title"');
    expect(ops).toContain(L_OPS.lede);
    expect(ops).toContain(L_OPS.close);
    expect((ops.match(/role="tab"/g) ?? []).length).toBe(L_OPS.steps.length);
    for (const step of L_OPS.steps) expect(ops).toContain(step.label);
    expect(ops).toContain(escape(L_OPS.steps[0].lines[0].text));
    for (const note of stepNotes(L_OPS.steps[0].line, L_OPS.steps[0].lines)) expect(ops).toContain(escape(note.text));
    // The notes are the step's own line, cut at its first comma, nothing added.
    for (const step of L_OPS.steps) {
      expect(stepNotes(step.line, step.lines).map(note => note.text).join('，')).toBe(step.line);
      expect(stepNotes(step.line, step.lines).length).toBeLessThanOrEqual(3);
    }
  });

  it('moves all 14 sample reports as cards that open in a dialog (off unless the preview or the flag shows them)', () => {
    const html = render();
    expect(L_REPORTS.length).toBe(14);
    for (const report of L_REPORTS) expect(html).toContain(`<b>${escape(report.who)}</b>${escape(report.platform)}`);
    expect(html).toContain('<dialog');
    expect(render(ALL_ON, false)).not.toContain('id="samples-title"');
  });

  it('lists the worries behind their flags and keeps the comparison on the light band, each pair ending on what to do', () => {
    const html = render();
    for (const item of L_CARE.items) expect(html).toContain(item.worry);
    expect(html).not.toContain('data-band="ink"');
    expect(html).toContain('data-band="tint"');
    const text = html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    for (const line of Object.values(L_COMPARE_NEXT)) expect(text).toContain(line);
  });

  it('shows the plan cards with Gold recommended and "先聊后买" right under them', () => {
    const html = render();
    const plans = between(html, 'data-region="会员方案"', 'id="faq-title"');
    expect(plans).toMatch(/data-plan="gold" data-recommended="true"/);
    expect(plans).not.toMatch(/data-plan="pro" data-recommended/);
    expect(plans).toContain(RISK_REVERSAL.title);
    for (const point of data.risk) expect(plans).toContain(point.text);
  });

  it('puts a button at least every two regions', () => {
    const html = render();
    const buttons = (part: string) => (part.match(/免费和教练聊聊|免费开始聊/g) ?? []).length;
    expect(buttons(between(html, 'id="hero-title"', 'id="voice-title"'))).toBeGreaterThan(0);
    expect(buttons(between(html, 'id="ops-title"', 'id="samples-title"'))).toBeGreaterThan(0);
    expect(buttons(between(html, 'id="samples-title"', 'id="care-title"'))).toBeGreaterThan(0);
    expect(buttons(between(html, 'id="compare-title"', 'id="pricing-title"'))).toBeGreaterThan(0);
  });

  it('never claims to be the first, the only or the world\'s first', () => {
    const main = render().split('<main')[1];
    for (const word of ['全球首个', '首个', '唯一', '全球第一', '业内第一', '第一家']) expect(main).not.toContain(word);
  });
});
