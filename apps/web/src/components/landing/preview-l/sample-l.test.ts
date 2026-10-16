import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/l/page';
import { SampleJ } from '@/components/landing/preview-j/SampleJ';
import { SampleK } from '@/components/landing/preview-k/SampleK';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { L_CARE, L_COMPARE_NEXT, L_COMPARE_TITLE, L_HERO_FLOW, L_NOTE_REGIONS, L_OPS } from '@/lib/landing/landing-copy-l';
import { VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { SampleL } from './SampleL';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
const render = (flags: LandingFlags = ALL_ON, showSamples = true) =>
  renderToStaticMarkup(createElement(SampleL, { data, siteName: 'Graylum', extras: { flags, showSamples } }));

describe('style sample L (sample K, second round, Owner 2026-10-17)', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('l')).toBe(true);
  });

  it('runs first screen, voices, daily operations, samples, worries, comparison, price, FAQ, close', () => {
    const html = render();
    const order = ['id="hero-title"', 'id="voice-title"', 'id="ops-title"', 'id="samples-title"', 'id="care-title"',
      'id="compare-title"', 'id="pricing-title"', 'id="faq-title"', 'id="final-title"'].map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('draws the first screen as you say → the coach does → you get, with no product window, each line behind its flag', () => {
    const html = render();
    const hero = html.slice(html.indexOf('id="hero-title"'), html.indexOf('id="voice-title"'));
    for (const text of [L_HERO_FLOW.youSay.text, L_HERO_FLOW.youGet.text]) expect(hero).toContain(text);
    expect(hero).not.toContain(J_WEEK.title);
    const off = render({ ...ALL_ON, publish: false });
    for (const item of L_HERO_FLOW.coachDoes.items) expect(off.includes(item.text)).toBe(!item.needs.includes('publish'));
  });

  it('shows every voice, unfolded, each with its region and never a guessed country', () => {
    const html = render();
    const wall = html.slice(html.indexOf('id="voice-title"'), html.indexOf('id="ops-title"'));
    for (const note of data.notes) expect(wall).toContain(L_NOTE_REGIONS[note.id]);
    expect(wall).not.toContain('看另外');
    for (const note of VOICE_WALL.notes.filter(item => item.source.startsWith('Reddit'))) expect(L_NOTE_REGIONS[note.id]).toBe('英文论坛');
  });

  it('makes region 3 daily operations from the real week conversation: clickable steps, no claims the product lacks', () => {
    const html = render();
    const ops = html.slice(html.indexOf('id="ops-title"'), html.indexOf('id="samples-title"'));
    expect(ops).toContain(L_OPS.lede);
    expect((ops.match(/role="tab"/g) ?? []).length).toBe(L_OPS.steps.length);
    expect(ops).toContain(escape(J_WEEK.topics.items[0].title));
    for (const word of ['AB 测试', 'A/B', '延伸']) expect(html).not.toContain(word);
    expect(render({ ...ALL_ON, publish: false }).match(/role="tab"/g)?.length).toBe(
      L_OPS.steps.filter(step => !step.needs.includes('publish')).length + J_SAMPLES.reports.length * 0);
  });

  it('moves the sample reports as cards that open in a dialog (off unless the preview or the flag shows them)', () => {
    const html = render();
    for (const report of J_SAMPLES.reports) expect(html).toContain(`<b>${report.who}</b>${report.platform}`);
    expect(html).toContain('<dialog');
    expect(render(ALL_ON, false)).not.toContain('id="samples-title"');
  });

  it('lists the worries with the coach behind each, voice first, no fixed weekdays', () => {
    const html = render();
    const care = html.slice(html.indexOf('id="care-title"'), html.indexOf('id="compare-title"'));
    expect(care.indexOf(L_CARE.items[0].worry)).toBeGreaterThan(0);
    expect(L_CARE.items[0].worry).toContain('文风');
    for (const day of ['周一', '周日', '周末复盘']) expect(care).not.toContain(day);
    expect(render({ ...ALL_ON, voice: false })).not.toContain(L_CARE.items[0].worry);
  });

  it('brings the comparison back to chat windows under "AI 教练带你一步步做", each ending on the next thing to do', () => {
    const html = render();
    const heading = html.slice(html.indexOf('id="compare-title"'), html.indexOf('</h2>', html.indexOf('id="compare-title"')));
    expect(heading.replace(/<[^>]+>/g, '')).toContain(L_COMPARE_TITLE);
    // The replies are typed out character by character: read them without the markup.
    const text = html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    for (const line of Object.values(L_COMPARE_NEXT)) expect(text).toContain(line);
  });

  it('shows the usual total whole (not struck) and drops the check date', () => {
    const html = render();
    expect(html).toContain(J_PRICE_TOTAL.text);
    expect(html).toContain('data-plain="true"');
    expect(html).not.toContain(J_PRICE.checked);
  });

  it('never claims to be the first, the only or the world\'s first', () => {
    const main = render().split('<main')[1];
    // "第一个月" and "这周第一步" are fine; a claim to be first or only is not.
    for (const word of ['全球首个', '首个', '唯一', '全球第一', '业内第一', '第一家']) expect(main).not.toContain(word);
  });

  it('leaves samples J and K as they were', () => {
    const extras = { flags: ALL_ON, showSamples: true };
    const j = renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', extras }));
    const k = renderToStaticMarkup(createElement(SampleK, { data, siteName: 'Graylum', extras }));
    for (const html of [j, k]) {
      for (const mark of ['data-plain', 'data-wide', `${L_NOTE_REGIONS.p1} · `]) expect(html).not.toContain(mark);
      expect(html).toContain(J_PRICE.checked);
    }
  });
});
