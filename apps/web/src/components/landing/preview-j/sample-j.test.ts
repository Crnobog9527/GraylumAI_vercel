import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/j/page';
import { FINAL_ACTION, H_COMPARE, HERO, HERO_H, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import * as copyJ from '@/lib/landing/landing-copy-j';
import { J_FAQ_REWORDS, J_ID_PLACEHOLDER, J_NOTE_HEADS, J_PRICE, J_TAKEOVER, noteSource } from '@/lib/landing/landing-copy-j';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { SampleJ } from './SampleJ';
import { arrivedAt } from './PositioningClipJ';
import { chapterAt, CHAPTERS } from './TakeoverJ';
import { WEEK_STEP_MS } from './WeekJ';
import { J_JURY_CHANGED, J_JURY_EVENTS, J_JURY_REPORT } from './jury-case-j';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import { J_TAKEOVER_SCENES } from '@/lib/landing/landing-copy-j-takeover';
import { J_WORK, J_WORK_SAMPLES, J_WORK_SCENES } from '@/lib/landing/landing-copy-j-work';
import { J_FOUNDER_BAR, J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});

function render() {
  const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
  return { data, html: renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', extras: { founderTotal: null, founderPrice: null, credits: { pro: 1000, gold: 1000 }, flags: ALL_ON } })) };
}

describe('style sample J', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('j')).toBe(true);
  });

  it('keeps the first screen to the final title, promise, button and note, with one H1', () => {
    const { html } = render();
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const hero = html.slice(html.indexOf('aria-labelledby="hero-title"'), html.indexOf('aria-labelledby="voice-title"'));
    for (const copy of [HERO.promise, HERO.primaryCta, HERO_H.ctaNote]) expect(hero).toContain(escape(copy));
    expect(hero.replace(/<[^>]+>/g, '')).toContain(HERO.title.replace(' 自', '自'));
    expect(hero).not.toContain(HERO.secondaryCta);
    // The Owner's edit mode exists only in a local development server, never in a build.
    expect(html).not.toContain('改字模式');
  });

  it('puts every voice-wall note, verbatim, beside a heading of its own and P7 first', () => {
    const { data, html } = render();
    const wall = html.slice(html.indexOf('aria-labelledby="voice-title"'), html.indexOf('id="how-it-works"'));
    for (const note of data.notes) {
      expect(wall).toContain(escape(note.quote));
      expect(J_NOTE_HEADS[note.id]).toBeTruthy();
      expect(wall).toContain(J_NOTE_HEADS[note.id]);
    }
    expect(wall.indexOf(escape(data.notes.find(note => note.id === 'p7')?.quote ?? '-'))).toBeLessThan(wall.indexOf(escape(data.notes[0].quote)));
    expect(wall).not.toMatch(/href="https?:/);
    expect(wall).not.toContain(VOICE_WALL.lede);
  });

  it('cites forum quotes as platform · user ID · date and news quotes as they were', () => {
    expect(noteSource('p7', 'Reddit r/socialmedia，2026-04')).toBe('Reddit r/socialmedia · u/DrRZXQ · 2026-04');
    expect(noteSource('p8', 'Reddit r/smallbusinessowner，2026-04')).toBe('Reddit r/smallbusinessowner · u/huttleai · 2026-04');
    expect(noteSource('p5', '方格子，约 2026')).toBe('方格子 · 享民頭條撰文 · 约 2026');
    // A forum note without a checked ID shows the placeholder rather than a guess.
    expect(noteSource('p9', '某论坛，2026')).toBe('某论坛，2026');
    expect(J_ID_PLACEHOLDER).toBe('【用户 ID 待补】');
    expect(noteSource('p1', '北京日报报道中的受访者，2024-11')).toBe('北京日报报道中的受访者，2024-11');
  });

  it('tells the story as static steps in the server HTML, with the Owner\'s benchmark wording and no old claim', () => {
    const { html } = render();
    expect(html).toContain(J_TAKEOVER.benchmarkLine);
    for (const scene of J_TAKEOVER_SCENES) {
      expect(html).toContain(scene.title);
      expect(html).toContain(escape(scene.note));
    }
    expect(html).toContain(J_TAKEOVER.juryTitle);
    // The scenes are the demo's made-up case: no figures, no promise of income.
    expect(JSON.stringify(J_TAKEOVER_SCENES)).not.toMatch(/\d+\s*%|\$|保证|一定能|稳赚/);
    // The long promise paragraph is never shown in one block any more.
    expect(html).not.toContain('你不用再分心研究运营技术，不用自己想选题');
    expect(JSON.stringify(copyJ)).not.toContain('程序算出来');
    expect(JSON.stringify(J_TAKEOVER_SCENES)).not.toContain('程序算');
  });
});

describe('style sample J, the later sections', () => {
  it('runs scenes, the comparison, price, FAQ and the close in order after the story', () => {
    const { html } = render();
    const order = ['id="how-it-works"', 'id="work-title"', 'id="compare-title"', 'id="pricing-title"', 'id="faq-title"', 'id="final-title"']
      .map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows all eight demos of the merged module, finished on the server, with no figures or income promise', () => {
    const { html } = render();
    for (const group of J_WORK.groups) expect(html).toContain(group);
    expect(html).toContain(J_WORK.close);
    for (const scene of J_WORK_SCENES) {
      expect(html).toContain(scene.title);
      expect(html).toContain(escape(scene.did));
      expect(html).toContain(escape(scene.result));
    }
    // The review lives in "不用自己看数据"; it is not a demo of its own any more.
    expect(J_WORK_SCENES.map(scene => scene.id)).not.toContain('review');
    // Nothing waits for a phase in the server HTML: every piece is already shown.
    const work = html.slice(html.indexOf('id="work-title"'), html.indexOf('id="compare-title"'));
    expect(work.match(/data-at=/g)?.length).toBe(work.match(/data-shown=""/g)?.length);
    expect(JSON.stringify([J_WORK_SCENES, J_WORK_SAMPLES])).not.toMatch(/\d+\s*%|\$|保证|一定能|稳赚/);
  });

  it('keeps the Owner\'s four-row comparison word for word, each row over its pair of conversations', () => {
    const { html } = render();
    for (const phrase of H_COMPARE.title.split(/(?<=，)/)) expect(html).toContain(escape(phrase));
    for (const row of H_COMPARE.rows) for (const cell of [row.generic, row.coach]) expect(html).toContain(escape(cell));
    expect(J_COMPARE.pairs).toHaveLength(H_COMPARE.rows.length);
    for (const pair of J_COMPARE.pairs) expect(html.split(escape(pair.question)).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('prices the usual ways first, each with its source beside it, then the cards, then 先聊后买', () => {
    const { html } = render();
    const pricing = html.slice(html.indexOf('id="pricing"'), html.indexOf('id="faq"'));
    for (const row of PRICE_COMPARE.rows) expect(pricing).toContain(escape(PRICE_COMPARE.sources[row.sourceId]));
    expect(pricing).toContain(J_PRICE.ownPrice('$29'));
    const anchors = pricing.indexOf(J_PRICE.compareTitle);
    const cards = pricing.indexOf('aria-label="Pro"');
    const risk = pricing.indexOf(RISK_REVERSAL.title);
    expect(anchors).toBeGreaterThan(0);
    expect(anchors).toBeLessThan(cards);
    expect(cards).toBeLessThan(risk);
    expect(pricing).toContain('href="/landing/pricing"');
  });

  it('opens the first question of each FAQ group and words the old "所有功能一键使用" less absolutely', () => {
    const { data, html } = render();
    const faq = html.slice(html.indexOf('id="faq"'), html.indexOf('id="final-title"'));
    expect(faq.match(/<details[^>]* open=""/g)).toHaveLength(data.faqGroups.length);
    for (const [from, to] of J_FAQ_REWORDS) {
      expect(faq).not.toContain(from);
      if (data.faqGroups.some(group => group.items.some(item => item.answer.some(text => text.includes(from))))) expect(faq).toContain(to);
    }
  });

  it('closes with the two paths and the same note under the button as the first screen', () => {
    const { html } = render();
    const close = html.slice(html.indexOf('id="final-title"'));
    for (const path of FINAL_ACTION.paths) expect(close).toContain(escape(path));
    expect(close).toContain(HERO_H.ctaNote);
  });
});

describe('sample J story timing', () => {
  it('maps the scroll to the four chapters in order, ending inside the last', () => {
    expect(CHAPTERS.map(chapter => chapter.id)).toEqual(['you', 'direction', 'benchmark', 'jury']);
    expect(chapterAt(0)).toEqual({ id: 'you', index: 0, local: 0 });
    expect(chapterAt(0.4).id).toBe('direction');
    expect(chapterAt(0.6).id).toBe('benchmark');
    expect(chapterAt(1)).toEqual({ id: 'jury', index: 3, local: 1 });
    expect(chapterAt(-1).id).toBe('you');
    // Every message of a scene has arrived before the scroll leaves it.
    for (const scene of J_TAKEOVER_SCENES) expect(arrivedAt(0.9, scene.lines.length)).toBe(scene.lines.length);
    expect(arrivedAt(0, 6)).toBe(1);
  });

  it('shows the first screen\'s week window at its last step on the server, with the five stages and no made-up numbers', () => {
    const { html } = render();
    expect(html).toContain('data-step="4"');
    for (const stage of J_WEEK.stages) expect(html).toContain(stage);
    expect(html).toContain(J_WEEK.review.rows[1][1].replace(/"/g, '&quot;'));
    expect(WEEK_STEP_MS).toHaveLength(J_WEEK.stages.length);
    const loop = WEEK_STEP_MS.reduce((sum, ms) => sum + ms, 0);
    expect(loop).toBeGreaterThanOrEqual(11000);
    expect(loop).toBeLessThanOrEqual(14000);
    expect(JSON.stringify(J_WEEK)).not.toMatch(/\d+\s*%|\$|\d{2,}/);
  });

  it('adds the usual ways up correctly, and every plan card leads to the pricing page, never straight to checkout', () => {
    const amounts = (id: string) => (PRICE_COMPARE.rows.find(row => row.sourceId === id)?.price ?? '')
      .match(/\$[\d,]+(?:–[\d,]+)?/)?.[0].replace(/[$,]/g, '').split('–').map(Number) ?? [];
    const [low] = amounts('consultant');
    const lowest = low + amounts('scheduler')[0] + amounts('benchmark')[0] + amounts('project')[0];
    expect(J_PRICE_TOTAL.text).toBe(`每月约 $${lowest.toLocaleString('en-US')} 起`);
    const { html } = render();
    expect(html).toContain(J_PRICE_TOTAL.label);
    const pricing = html.slice(html.indexOf('id="pricing"'), html.indexOf('id="faq"'));
    expect(pricing).not.toMatch(/checkout|plan=|tab=subscription/);
    expect(pricing.match(/href="\/landing\/pricing"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('shows the founder bar in the v25 form only while seats are left', () => {
    const offers = { founder: { price: 496, total: 50, available: 37 } };
    const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)], offers);
    const extras = { founderTotal: 50, founderPrice: 496, credits: {}, flags: ALL_ON };
    const html = renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', extras }));
    expect(html).toContain(J_FOUNDER_BAR.title);
    expect(html).toContain(J_FOUNDER_BAR.joined(13, 37));
    expect(html).toContain(J_FOUNDER_BAR.rule('$496'));
    // Owner 2026-10-14 (MASTER_PLAN 2.1, as in #987): the founder price is never called "终身".
    expect(html).not.toContain('终身');
    const soldOut = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)],
      { founder: { price: 496, total: 50, available: 0 } });
    expect(renderToStaticMarkup(createElement(SampleJ, { data: soldOut, siteName: 'Graylum', extras }))).not.toContain(J_FOUNDER_BAR.title);
  });
});

describe('sample J jury case (for #1002\'s canvas player)', () => {
  it('follows the full scenario\'s order and ends on a revision of the changed chapters', () => {
    const types = J_JURY_EVENTS.map(event => event.type);
    expect(types[0]).toBe('review_started');
    expect(types.slice(-2)).toEqual(['revision_ready_for_choice', 'review_ended']);
    const at = (type: (typeof types)[number]) => types.indexOf(type);
    expect(at('disagreement')).toBeLessThan(types.lastIndexOf('reviewer_started'));
    expect(at('summary_started')).toBeLessThan(at('adjudication'));
    expect(new Set(J_JURY_EVENTS.map(event => event.id)).size).toBe(J_JURY_EVENTS.length);
    const ready = J_JURY_EVENTS.find(event => event.type === 'revision_ready_for_choice');
    expect(ready && 'changedSectionTitles' in ready ? ready.changedSectionTitles : []).toEqual([...J_JURY_CHANGED]);
  });

  it('keeps every event text within 120 characters, with no model names and no figures', () => {
    const texts = J_JURY_EVENTS.flatMap(event => Object.entries(event)
      .filter(([key, value]) => typeof value === 'string' && !['id', 'type', 'section', 'state', 'outcome', 'decision', 'verdict',
        'stance', 'reviewer', 'to', 'severity', 'perspective'].includes(key))
      .map(([, value]) => value as string));
    expect(texts.length).toBeGreaterThan(20);
    for (const text of texts) expect(Array.from(text).length).toBeLessThanOrEqual(120);
    const all = JSON.stringify([J_JURY_EVENTS, J_JURY_REPORT]).replace(/第 \d+ 章|第一个 30 天计划/g, '').replace(/":\d+|j-jury-\d+/g, '');
    expect(all).not.toMatch(/\d|GPT|Claude|Gemini|DeepSeek|Qwen|模型 [A-C]/i);
  });
});

