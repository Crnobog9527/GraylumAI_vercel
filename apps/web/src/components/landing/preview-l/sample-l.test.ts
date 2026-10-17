import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/l/page';
import { SampleJ } from '@/components/landing/preview-j/SampleJ';
import { SampleK } from '@/components/landing/preview-k/SampleK';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { L_HERO_FLOW, L_NOTE_REGIONS, L_REPORTS } from '@/lib/landing/landing-copy-l';
import { L_ACTS } from '@/lib/landing/landing-copy-l-acts';
import { L_TASKS, L_TASKS_TITLE } from '@/lib/landing/landing-copy-l-compare';
import { loadSampleReport, SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import { splitReport } from '@/lib/landing/sample-reports/report-markdown';
import { VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { L_SAMPLES_REDO } from '@/lib/landing/landing-copy-l-samples';
import { GlanceL } from './GlanceL';
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

  it('runs first screen, voices, the two acts, the library and voice, samples, comparison, price, FAQ, close', () => {
    const html = render();
    const order = ['id="hero-title"', 'id="voice-title"', 'id="acts-title"', 'data-region="资料库和文风"', 'id="samples-title"',
      'id="compare-title"', 'id="pricing-title"', 'id="faq-title"', 'id="final-title"'].map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Region 5 is gone (merged into act two) and the home page carries no plan cards (Owner 2026-10-17, round three).
    expect(html).not.toContain('id="care-title"');
    expect(html).not.toContain('data-plan=');
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

  it('plays region 3 in two acts: the positioning flow on the real workspace, then the week in the real work chat', () => {
    const html = render();
    const acts = html.slice(html.indexOf('id="acts-title"'), html.indexOf('data-region="资料库和文风"'));
    for (const act of L_ACTS.acts) expect(acts).toContain(act);
    // Act one opens on the real workspace: its step strip, the checklist, the product's message head.
    for (const real of ['我的定位分析', '定位清单', 'AI 自媒体陪跑教练 · 了解你']) expect(acts).toContain(real);
    for (const step of L_ACTS.one) expect(acts).toContain(step.label);
    expect(acts).toContain(L_ACTS.why);
    // The jury left the home page: one line links to it, with the fusion flag.
    expect(acts).toContain(L_ACTS.jury.link);
    expect(render({ ...ALL_ON, fusion: false })).not.toContain(L_ACTS.jury.link);
    expect(acts).not.toContain('开启评审团');
  });

  it('lists act two\'s six steps behind their flags, with region 5\'s worries merged in and no fixed weekdays', () => {
    expect(L_ACTS.two.map(step => step.label)).toEqual(['选题和封面', '口播稿和分镜脚本', 'AB 测试', '自动发布', '数据监控', '复盘']);
    expect(L_ACTS.two.filter(step => step.needs.includes('publish')).map(step => step.label)).toEqual(['自动发布', '数据监控']);
    for (const step of L_ACTS.two) {
      expect(step.worry.length).toBeGreaterThan(3);
      for (const day of ['周一', '周日', '周末复盘']) expect(`${step.worry}${step.does}`).not.toContain(day);
    }
    // The review's numbers come from the monitoring with publish on, from the person with it off.
    const review = L_ACTS.two.find(step => step.label === '复盘');
    expect(review?.lines.some(line => line.role === 'user' && line.without === 'publish')).toBe(true);
  });

  it('moves every group\'s sample report as a card of one shape, every copy clickable, opening in a dialog', () => {
    const html = render();
    expect(L_REPORTS.length).toBe(14);
    const start = html.indexOf('id="samples-title"');
    const region = html.slice(start, html.indexOf('</dialog>', start));
    expect(region).toContain(L_SAMPLES_REDO.title);
    for (const word of ['用户案例', '人物为虚构', '教练说真话']) expect(region).not.toContain(word);
    for (const report of L_REPORTS) {
      expect(region).toContain(`<b>${escape(report.who)}</b>${escape(report.platform)}`);
      expect(region).toContain(escape(SAMPLE_CHAPTERS[report.slug].summary.what));
    }
    // The loop's second copy is hidden from screen readers and the tab order, but never inert: a click on it works.
    expect(region).not.toContain('inert');
    expect(region).toMatch(/<ul[^>]*aria-hidden="true"/);
    const buttons = region.match(/<button type="button"[^>]*data-slug="[^"]+"[^>]*>/g) ?? [];
    expect(buttons.length).toBe(L_REPORTS.length * 2);
    expect(buttons.filter(button => button.includes('tabindex="-1"'))).toHaveLength(L_REPORTS.length);
    // One grey 示例 tag on every card, 方向已调整 on the reports whose direction the coach changed.
    expect(region.split(`>${L_SAMPLES_REDO.sample}<`).length - 1).toBe(L_REPORTS.length * 2);
    expect(region.split(`>${L_SAMPLES_REDO.adjusted}<`).length - 1).toBe(L_REPORTS.filter(report => report.truth).length * 2);
    expect(html).toContain('<dialog');
    expect(render(ALL_ON, false)).not.toContain('id="samples-title"');
  });

  it('reads the 10-second card top to bottom: who and platform, the risk first, the sentence, three blocks', () => {
    const report = L_REPORTS.find(item => item.truth) ?? L_REPORTS[0];
    const data = SAMPLE_CHAPTERS[report.slug];
    const html = renderToStaticMarkup(createElement(GlanceL, { data, who: report.who, platform: report.platform }));
    const order = [escape(report.who), L_SAMPLES_REDO.glance.risk, escape(data.summary.truth ?? ''), escape(data.summary.what),
      L_SAMPLES_REDO.glance.who, L_SAMPLES_REDO.glance.money, L_SAMPLES_REDO.glance.first].map(mark => html.indexOf(mark));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const plain = L_REPORTS.find(item => !item.truth) ?? L_REPORTS[0];
    const calm = renderToStaticMarkup(createElement(GlanceL, { data: SAMPLE_CHAPTERS[plain.slug], who: plain.who, platform: plain.platform }));
    expect(calm).not.toContain(L_SAMPLES_REDO.glance.risk);
  });

  it('compares the same four tasks done by a general AI and by the coach, each with its verdict and next step', () => {
    const html = render();
    const compare = html.slice(html.indexOf('id="compare-title"'), html.indexOf('id="pricing-title"'));
    const text = compare.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    expect(text).toContain(L_TASKS_TITLE);
    for (const task of L_TASKS) {
      expect(text).toContain(task.question);
      expect(text).toContain(task.verdict);
      expect(text).toContain(task.head);
      expect(task.coach).toContain('接下来你做');
    }
    for (const brand of ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', '豆包', 'Kimi']) expect(text).not.toContain(brand);
    expect(render({ ...ALL_ON, publish: false })).not.toContain(escape(L_TASKS[3].question));
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

  it('ships the new reports whole and sanitized: 14 chapters each, no links, handles or data vendor names', async () => {
    for (const report of L_REPORTS) {
      const data = SAMPLE_CHAPTERS[report.slug];
      expect(data.chapters).toHaveLength(14);
      expect(Boolean(data.summary.truth)).toBe(report.truth);
      const markdown = await loadSampleReport(report.slug);
      expect(splitReport(markdown).chapters).toHaveLength(14);
      for (const text of [markdown, JSON.stringify(data)]) expect(text).not.toMatch(/https?:|www\.|@[A-Za-z0-9_]|monid/i);
    }
  });

  it('shows act two in the work chat\'s own head, with no invented window names', () => {
    const html = render();
    const acts = html.slice(html.indexOf('id="acts-title"'), html.indexOf('data-region="资料库和文风"'));
    // Window names the product never shows ("第一周" may still occur inside a coach's own words).
    for (const invented of ['· 这一周', '帮你挖掘定位', '· 第一周']) expect(acts).not.toContain(invented);
    expect(L_ACTS.two.every(step => step.lines.length > 0)).toBe(true);
  });

  it('keeps the price comparison, our price quiet, and 先聊后买 right by its button', () => {
    const html = render();
    const price = html.slice(html.indexOf('id="pricing-title"'), html.indexOf('id="faq-title"'));
    expect(price).toContain('data-quiet="true"');
    expect(price).toContain('先聊后买');
    expect(price).not.toContain('data-plan=');
  });

  it('keeps one button wording and a button at least every two regions', () => {
    const html = render();
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain('免费和教练聊聊');
    expect(header).not.toContain('>免费试用<');
    const between = (from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to)).includes('免费和教练聊聊');
    expect(between('id="voice-title"', 'id="acts-title"')).toBe(true);
    expect(between('id="acts-title"', 'data-region="资料库和文风"')).toBe(true);
    expect(between('id="compare-title"', 'id="pricing-title"')).toBe(true);
  });

  it('keeps "14 种人" in one piece in the samples\' lede', () => {
    expect(render()).toMatch(/<span[^>]*>14 种人<\/span>/);
  });
});

