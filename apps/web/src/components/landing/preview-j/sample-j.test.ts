import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/j/page';
import { H_COMPARE, HERO, HERO_H, PRICE_COMPARE, RISK_REVERSAL, VOICE_WALL } from '@/lib/landing/landing-copy';
import * as copyJ from '@/lib/landing/landing-copy-j';
import { J_FAQ_REWORDS, J_FINAL, J_HERO_PROMISE, J_ID_PLACEHOLDER, J_NOTE_HEADS, J_PRICE, J_TAKEOVER, noteSource } from '@/lib/landing/landing-copy-j';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { SampleJ } from './SampleJ';
import { arrivedAt } from './PositioningClipJ';
import { chapterAt, CHAPTERS } from './TakeoverJ';
import { WEEK_LOOP_MS } from './WeekJ';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import { J_REPORT, J_TAKEOVER_MOMENTS } from '@/lib/landing/landing-copy-j-takeover';
import { J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_SAMPLES, samplePath } from '@/lib/landing/landing-copy-j-samples';
import { J_WORK, J_WORK_SCENES } from '@/lib/landing/landing-copy-j-work';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});

function render() {
  const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
  return { data, html: renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', extras: { flags: ALL_ON } })) };
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
    for (const copy of [J_HERO_PROMISE, HERO.primaryCta, HERO_H.ctaNote]) expect(hero).toContain(escape(copy));
    expect(hero).not.toContain("交给它");
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
    for (const moment of J_TAKEOVER_MOMENTS) {
      expect(html).toContain(moment.caption);
      expect(html).toContain(escape(moment.note));
    }
    // The product's own steps appear in the workbench strip; the report comes from its footer, the jury from the report.
    for (const step of J_STEPS) expect(html).toContain(step.title);
    expect(html).toContain('AI 自媒体陪跑教练 · 了解你');
    expect(html).toContain('本步小结 · ');
    expect(html).toContain(J_REPORT.export);
    for (const chapter of J_REPORT.chapters) expect(html).toContain(chapter.title);
    expect(html).not.toMatch(/你是谁|方向判断/);
    expect(html).toContain(J_REPORT.generate);
    expect(html).toContain(J_REPORT.juryEntry);
    // The scenes are the demo's made-up case: no figures, no promise of income.
    expect(JSON.stringify(J_TAKEOVER_MOMENTS)).not.toMatch(/\d+\s*%|\$|保证|一定能|稳赚/);
    // The long promise paragraph is never shown in one block any more.
    expect(html).not.toContain('你不用再分心研究运营技术，不用自己想选题');
    expect(JSON.stringify(copyJ)).not.toContain('程序算出来');
    expect(JSON.stringify(J_TAKEOVER_MOMENTS)).not.toContain('程序算');
    // One example person on the whole page (Owner 2026-10-15): the dental assistant is gone.
    expect(html).not.toMatch(/牙科|牙助/);
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

  it('shows all eight demos step by step, each finished on the server, with no figures or income promise', () => {
    const { html } = render();
    for (const group of J_WORK.groups) expect(html).toContain(group);
    expect(html).toContain(J_WORK.close);
    for (const scene of J_WORK_SCENES) {
      expect(html).toContain(scene.title);
      expect(html).toContain(escape(scene.result));
      // Every demo is a walk-through of three to five steps, each with its own explanation.
      expect(scene.steps.length).toBeGreaterThanOrEqual(3);
      expect(scene.steps.length).toBeLessThanOrEqual(5);
      for (const step of scene.steps) expect(step.explain.length).toBeGreaterThan(10);
      // At rest each demo shows its last step.
      expect(html).toContain(escape(scene.steps[scene.steps.length - 1].explain));
    }
    // The review lives in "不用自己看数据"; it is not a demo of its own any more.
    expect(J_WORK_SCENES.map(scene => scene.id)).not.toContain('review');
    const text = JSON.stringify(J_WORK_SCENES).replace(/15 分钟|十五分钟/g, '');
    expect(text).not.toMatch(/\d+\s*%|\$|\d{2,}|保证|一定能|稳赚/);
    // The AI coach is named, never "它" (Owner 2026-10-15).
    expect(JSON.stringify([J_WORK, J_WORK_SCENES])).not.toMatch(/它(?!们)/);
  });

  it('keeps the Owner\'s four-row comparison word for word, each row over its pair of conversations', () => {
    const { html } = render();
    for (const phrase of H_COMPARE.title.split(/(?<=，)/)) expect(html).toContain(escape(phrase));
    for (const row of H_COMPARE.rows) for (const cell of [row.generic, row.coach]) expect(html).toContain(escape(cell));
    expect(J_COMPARE.pairs).toHaveLength(H_COMPARE.rows.length);
    for (const pair of J_COMPARE.pairs) expect(html.split(escape(pair.question)).length - 1).toBeGreaterThanOrEqual(2);
  });

  it('prices only the usual ways against ours, with the way to the pricing page; no plans, founder offer or 先聊后买', () => {
    const { html } = render();
    const pricing = html.slice(html.indexOf('id="pricing"'), html.indexOf('id="faq"'));
    for (const row of PRICE_COMPARE.rows) expect(pricing).toContain(escape(PRICE_COMPARE.sources[row.sourceId]));
    expect(pricing).toContain(J_PRICE.ownPrice('$29'));
    expect(pricing).toContain(J_PRICE.more);
    expect(pricing).toContain('href="/landing/pricing"');
    expect(pricing.indexOf(J_PRICE_TOTAL.text)).toBeLessThan(pricing.indexOf(J_PRICE.ownPrice('$29')));
    // Owner 2026-10-15: plan cards, the founder offer and "先聊后买" are off the home page.
    expect(pricing).not.toContain('aria-label="Pro"');
    expect(pricing).not.toContain(RISK_REVERSAL.title);
    expect(html).not.toContain('创始会员');
    expect(pricing).not.toMatch(/checkout|plan=|tab=subscription/);
    // The FAQ follows the price directly.
    expect(html.indexOf('id="faq"')).toBeGreaterThan(html.indexOf('id="pricing"'));
  });

  it('starts every FAQ answer closed and words the old "所有功能一键使用" less absolutely', () => {
    const { data, html } = render();
    const faq = html.slice(html.indexOf('id="faq"'), html.indexOf('id="final-title"'));
    expect(faq).toContain('<details');
    expect(faq).not.toMatch(/<details[^>]* open=""/);
    for (const [from, to] of J_FAQ_REWORDS) {
      expect(faq).not.toContain(from);
      if (data.faqGroups.some(group => group.items.some(item => item.answer.some(text => text.includes(from))))) expect(faq).toContain(to);
    }
  });

  it('closes with one push from the visitor\'s side, the button and the same note as the first screen', () => {
    const { html } = render();
    const close = html.slice(html.indexOf('id="final-title"'));
    for (const text of [J_FINAL.title, J_FINAL.line, J_FINAL.cta, J_FINAL.note]) expect(close).toContain(text);
    expect(JSON.stringify(J_FINAL)).not.toMatch(/它|保证|一定能|稳赚|月入/);
  });
});

describe('sample J story timing', () => {
  it('maps the scroll to the four chapters in order, ending inside the last', () => {
    expect(CHAPTERS.map(chapter => chapter.id)).toEqual(J_TAKEOVER_MOMENTS.map(moment => moment.id));
    expect(chapterAt(0)).toEqual({ id: 'know', index: 0, local: 0 });
    expect(chapterAt(0.3).id).toBe('diagnose');
    expect(chapterAt(0.4).id).toBe('plan');
    expect(chapterAt(0.55).id).toBe('report');
    expect(chapterAt(0.8).id).toBe('jury');
    expect(chapterAt(1)).toEqual({ id: 'jury', index: 4, local: 1 });
    expect(chapterAt(-1).id).toBe('know');
    // Every message of a moment has arrived before the scroll leaves it.
    for (const moment of J_TAKEOVER_MOMENTS) expect(arrivedAt(0.9, moment.lines.length)).toBe(moment.lines.length);
    expect(arrivedAt(0, 6)).toBe(1);
  });

  it('shows the first screen\'s week window at its review on the server, the coach driving, about a minute per loop', () => {
    const { html } = render();
    for (const stage of J_WEEK.stages) expect(html).toContain(stage);
    for (const row of J_WEEK.platforms.rows) expect(html).toContain(row[2]);
    expect(WEEK_LOOP_MS).toBeGreaterThanOrEqual(40000);
    expect(WEEK_LOOP_MS).toBeLessThanOrEqual(60000);
    // Every stage is a few rounds, not one question and one answer.
    for (const index of J_WEEK.stages.keys()) expect(J_WEEK.lines.filter(line => line.stage === index).length).toBeGreaterThanOrEqual(3);
    // No figures beyond the person's own 15 minutes and one hour.
    expect(JSON.stringify(J_WEEK).replace(/15 分钟|十五分钟|七点/g, '')).not.toMatch(/\d+\s*%|\$|\d{2,}/);
  });

  it('adds the usual ways up correctly', () => {
    const amounts = (id: string) => (PRICE_COMPARE.rows.find(row => row.sourceId === id)?.price ?? '')
      .match(/\$[\d,]+(?:–[\d,]+)?/)?.[0].replace(/[$,]/g, '').split('–').map(Number) ?? [];
    const [low] = amounts('consultant');
    const lowest = low + amounts('scheduler')[0] + amounts('benchmark')[0] + amounts('project')[0];
    expect(J_PRICE_TOTAL.text).toBe(`每月约 $${lowest.toLocaleString('en-US')} 起`);
    expect(render().html).toContain(J_PRICE_TOTAL.label);
  });
});

describe('sample J sample reports', () => {
  it('stays off unless the preview or the flag turns it on, and then shows the four groups as placeholders', () => {
    const { data, html } = render();
    expect(html).not.toContain(J_SAMPLES.title);
    const extras = { flags: ALL_ON, showSamples: true };
    const shown = renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', extras }));
    expect(shown).toContain(J_SAMPLES.title);
    // Four reports to switch between; the first opens on its cover and every chapter of the real report.
    for (const report of J_SAMPLES.reports) expect(shown).toContain(`<b>${report.who}</b><span>${report.platform}</span>`);
    expect(shown).toContain(`href="${samplePath(J_SAMPLES.reports[0].slug)}"`);
    expect(shown).toContain(J_SAMPLES.size);
    for (const chapter of J_SAMPLES.chapters) expect(shown).toContain(chapter.title);
    expect(J_SAMPLES.chapters).toHaveLength(14);
    // Nothing of the reports themselves is made up: every key conclusion waits for the real report.
    expect(shown.split(J_SAMPLES.pending).length - 1).toBe(J_SAMPLES.chapters.length + 1);
    expect(J_SAMPLES.reports.filter(report => report.truth).map(report => report.slug)).toEqual(['student']);
    // Opening the takeover module: the samples come before the workspace.
    expect(shown.indexOf(J_SAMPLES.title)).toBeLessThan(shown.indexOf('我的定位分析'));
    expect(shown.indexOf(J_SAMPLES.title)).toBeGreaterThan(shown.indexOf('id="voice-title"'));
  });
});

