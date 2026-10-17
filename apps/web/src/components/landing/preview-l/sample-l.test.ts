import { createElement, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/l/page';
import { SampleJ } from '@/components/landing/preview-j/SampleJ';
import { SampleK } from '@/components/landing/preview-k/SampleK';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { L_HERO_FLOW, L_NOTE_REGIONS, L_REPORTS } from '@/lib/landing/landing-copy-l';
import { L_JURY, L_SCENARIOS, L_STEPS } from '@/lib/landing/landing-copy-l-steps';
import { L_TASKS, L_TASKS_TITLE } from '@/lib/landing/landing-copy-l-compare';
import { loadSampleReport, SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import { splitReport } from '@/lib/landing/sample-reports/report-markdown';
import { VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { L_SAMPLES_REDO } from '@/lib/landing/landing-copy-l-samples';
import { SAMPLE_OVERVIEWS } from '@/lib/landing/sample-reports/overview';
import { L_WORKFLOWS } from '@/lib/landing/landing-copy-l-workflows';
import { L_LATER } from '@/lib/landing/landing-copy-l-later';
import { HOW_IT_WORKS as HOW } from '@/lib/landing/landing-copy';
import { trpc } from '@/trpc/client';
import { countOf, OverviewL } from './OverviewL';
import { PositioningPictureL } from './PositioningPictureL';
import { SampleL } from './SampleL';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
// The page sits inside the app's tRPC provider (root layout); the real message box (WorkComposer) needs it. Nothing is fetched.
const queryClient = new QueryClient();
const client = trpc.createClient({ links: [httpLink({ url: 'http://landing.test/api/trpc' })] });
const withTrpc = (node: ReactElement) =>
  createElement(trpc.Provider, { client, queryClient, children: createElement(QueryClientProvider, { client: queryClient }, node) });
const render = (flags: LandingFlags = ALL_ON, showSamples = true) =>
  renderToStaticMarkup(withTrpc(createElement(SampleL, { data, siteName: 'Graylum', extras: { flags, showSamples } })));

describe('style sample L (sample K, second round, Owner 2026-10-17)', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('l')).toBe(true);
  });

  it('runs first screen, voices, step one, the jury, samples, comparison, price, FAQ, close', () => {
    const html = render();
    const order = ['id="hero-title"', 'id="voice-title"', 'id="steps-title"', 'id="jury-title"', 'id="samples-title"',
      'id="compare-title"', 'id="pricing-title"', 'id="faq-title"', 'id="final-title"'].map(mark => html.indexOf(mark));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Region 5 is gone (merged into act two) and the home page carries no plan cards (Owner 2026-10-17, round three).
    expect(html).not.toContain('id="care-title"');
    expect(html).not.toContain('data-plan=');
  });

  it('keeps only the first screen\'s text, centred, with no picture beside it (round four)', () => {
    const html = render();
    const hero = html.slice(html.indexOf('id="hero-title"'), html.indexOf('id="voice-title"'));
    for (const text of [L_HERO_FLOW.youSay.text, L_HERO_FLOW.youGet.text]) expect(hero).not.toContain(text);
    expect(hero).not.toContain('<figure');
  });

  it('shows every voice, unfolded, each with its region and never a guessed country', () => {
    const html = render();
    const wall = html.slice(html.indexOf('id="voice-title"'), html.indexOf('id="steps-title"'));
    for (const note of data.notes) expect(wall).toContain(L_NOTE_REGIONS[note.id]);
    expect(wall).not.toContain('看另外');
    for (const note of VOICE_WALL.notes.filter(item => item.source.startsWith('Reddit'))) expect(L_NOTE_REGIONS[note.id]).toBe('英文论坛');
  });

  it('plays step one as sample J\'s whole flow on the real product\'s parts, no lead-in before its notes', () => {
    const html = render();
    const steps = html.slice(html.indexOf('id="steps-title"'), html.indexOf('id="jury-title"'));
    // The region's own title first, then 第一步 under it (round five).
    expect(steps.indexOf(HOW.title)).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(HOW.title)).toBeLessThan(steps.indexOf(L_STEPS.one.title));
    for (const real of ['我的定位分析', '定位清单', 'AI 自媒体陪跑教练 · 主动引导 · 了解你', 'aria-label="添加资料"', 'aria-label="发送"']) {
      expect(steps).toContain(real);
    }
    // It opens with the coach, never with a message of the person's.
    expect(steps.indexOf('data-message-role="assistant"')).toBeLessThan(steps.indexOf('data-message-role="user"'));
    for (const stage of L_STEPS.one.stages) { expect(steps).toContain(stage.label); expect(steps).toContain(escape(stage.note)); }
    expect(steps).not.toContain('为什么不是正确的废话');
    // The research stage shows the product's own search record and benchmark table; the report its dialog, written.
    for (const real of ['aria-label="搜索记录"', '对标账号 A', '对标账号 G', '完整运营策略报告']) expect(steps).toContain(real);
    expect(steps).not.toContain('AB 测试');
  });

  it('docks the open question in the real message box, as the product page does, and drops it once answered', () => {
    const open = renderToStaticMarkup(withTrpc(createElement(PositioningPictureL, { moment: 0, local: 0 })));
    expect(open).toContain('data-question-card="open"');
    expect(open.indexOf('data-question-card="open"')).toBeGreaterThan(open.indexOf('role="log"'));
    expect(open).toContain('AI 自媒体陪跑教练 · 主动引导');
    expect(open).not.toContain('data-message-role="user"');
    const answered = renderToStaticMarkup(withTrpc(createElement(PositioningPictureL, { moment: 0, local: 1 })));
    expect(answered).not.toContain('data-question-card="open"');
  });

  it('shows steps two and three in full, as the launched product, and the jury larger', () => {
    const on = render();
    for (const step of [L_LATER.two, L_LATER.three]) {
      expect(on).toContain(step.title);
      for (const stage of step.stages) expect(on).toContain(`${stage.label}</button>`);
    }
    // Which stages show the product's real components and which the plan: every stage says so.
    for (const stage of [...L_LATER.two.stages, ...L_LATER.three.stages]) expect(['real', 'planned']).toContain(stage.source);
    expect(on).toContain(L_JURY.title);
    expect(on).toContain(`href="${L_JURY.href}"`);
    for (const word of ['世界最强', '没有分歧']) expect(on).not.toContain(word);
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

  it('draws each report\'s 15-second overview from its own figures: risk first, missing figures not drawn', () => {
    for (const report of L_REPORTS) {
      const data = SAMPLE_OVERVIEWS[report.slug];
      expect(data).toBeDefined();
      const html = renderToStaticMarkup(createElement(OverviewL, { data }));
      const copy = L_SAMPLES_REDO.overview;
      const order = [escape(data.positioning), data.riskAlert ? copy.risk : null, copy.audience, copy.platform, copy.funnel, copy.plan30, copy.first]
        .filter((mark): mark is string => Boolean(mark)).map(mark => html.indexOf(mark));
      expect(order.every(index => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (const item of data.benchmarks) expect(html).toContain(copy.benchmark(item.id));
      if (data.benchmarks.every(item => !item.medianViews)) expect(html).not.toContain(copy.medianViews);
      expect(html).toContain(`>${copy.sketch}<`);
      const text = html.replace(/<[^>]+>/g, '');
      for (const word of ['虚构', 'AI 自媒体陪跑教练', 'http', '@']) expect(text).not.toContain(word);
    }
    expect(countOf('约 1.93 万')).toBe(19300);
    expect(countOf('订阅 15,200')).toBe(15200);
    expect(countOf(null)).toBeNull();
  });

  it('compares one scenario at a time: tabs, its title and point, the typed pair, the verdict, marked 示意', () => {
    const html = render();
    const compare = html.slice(html.indexOf('id="compare-title"'), html.indexOf('id="pricing-title"'));
    const text = compare.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"');
    expect(text).toContain(L_TASKS_TITLE);
    for (const item of L_SCENARIOS.items) expect(text).toContain(item.tab);
    expect((compare.match(/role="tab"/g) ?? []).length).toBe(L_TASKS.length);
    // Only the first scenario is on screen: its own title and point, the pair and the verdict.
    const first = [L_SCENARIOS.items[0].title, L_SCENARIOS.items[0].lede, L_TASKS[0].question, L_TASKS[0].verdict];
    for (const shown of first) expect(text).toContain(shown);
    expect(text).not.toContain(L_TASKS[1].question);
    expect(text).toContain(L_SCENARIOS.badge);
    // The coach's side is a whole work conversation: library read, data fetched, the decision, what to do next, a follow-up.
    for (const turn of L_WORKFLOWS[0]) expect(text).toContain(turn.user);
    expect(text).toContain('已读取资料库');
    expect(compare).toContain('aria-label="搜索记录"');
    for (const turns of L_WORKFLOWS) expect(turns.every(turn => turn.reply.includes('接下来你做') || turn === turns[0] && turns.length > 1)).toBe(true);
    for (const task of L_TASKS) expect(task.coach).toContain('接下来你做');
    for (const brand of ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', '豆包', 'Kimi']) expect(text).not.toContain(brand);
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

  it('carries no statement that the people are made up, and no hover hint under the cards (round five)', async () => {
    for (const report of L_REPORTS) {
      const markdown = await loadSampleReport(report.slug);
      for (const line of ['人物是为说明各人群虚构的示例', '人物虚构', '细节虚构', '人物为虚构']) expect(markdown).not.toContain(line);
    }
    const html = render();
    for (const hint of ['移到卡片上会停下', '左右滑动看更多']) expect(html).not.toContain(hint);
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
    expect(between('id="voice-title"', 'id="steps-title"')).toBe(true);
    expect(between('id="steps-title"', 'id="jury-title"')).toBe(true);
    expect(between('id="compare-title"', 'id="pricing-title"')).toBe(true);
  });

  it('keeps "14 种人" in one piece in the samples\' lede', () => {
    expect(render()).toMatch(/<span[^>]*>14 种人<\/span>/);
  });
});

