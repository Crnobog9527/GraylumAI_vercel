import { createElement, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/l/page';
import { SampleJ } from '@/components/landing/preview-j/SampleJ';
import { SampleK } from '@/components/landing/preview-k/SampleK';
import { J_NOTE_HEADS, J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { L_HERO_FLOW, L_NOTE_ANSWERS, L_NOTE_HEADS, L_NOTE_REGIONS, L_REPORTS } from '@/lib/landing/landing-copy-l';
import { L_JURY, L_SCENARIOS, L_STEPS } from '@/lib/landing/landing-copy-l-steps';
import { L_TASKS, L_TASKS_TITLE } from '@/lib/landing/landing-copy-l-compare';
import { OFFICE_WORKER_REPORT } from '@/lib/landing/sample-reports/office-worker';
import { loadSampleReport, SAMPLE_CHAPTERS } from '@/lib/landing/sample-reports';
import { splitReport } from '@/lib/landing/sample-reports/report-markdown';
import { VOICE_WALL } from '@/lib/landing/landing-copy';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { L_SAMPLES_REDO } from '@/lib/landing/landing-copy-l-samples';
import { SAMPLE_OVERVIEWS } from '@/lib/landing/sample-reports/overview';
import { L_WORKFLOWS, SCRIPT, SHOTS } from '@/lib/landing/landing-copy-l-workflows';
import { L_LATER, L_LATER_CHAT, L_LATER_FLYWHEEL } from '@/lib/landing/landing-copy-l-later';
import { L_DIRECTION_CARD, L_POSITIONING_MOMENTS, L_SKILL_OPENING } from '@/lib/landing/landing-copy-l-positioning';
import { L_PRICE_NOTE } from '@/lib/landing/landing-copy-l';
import { HOW_IT_WORKS as HOW } from '@/lib/landing/landing-copy';
import { trpc } from '@/trpc/client';
import { countOf, OverviewL } from './OverviewL';
import { L_BENCHMARK_ROWS } from './RealPartsL';
import { scenarioAt } from './ScenariosL';
import { PositioningPictureL } from './PositioningPictureL';
import { linePhases, momentAt } from '@/lib/landing/step-one-timeline';
import { SampleL } from './SampleL';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
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

  it('answers each voice with sample L\'s own wording, in the Owner\'s order, leaving sample J\'s alone (2026-10-18)', () => {
    const wall = render().slice(0, render().indexOf('id="steps-title"'));
    const from = wall.indexOf('id="voice-title"');
    let last = from;
    for (const id of ['p7', 'p1', 'p2', 'p3', 'p4', 'p5', 'p8']) {
      const at = wall.indexOf(escape(L_NOTE_HEADS[id]), from);
      expect(at).toBeGreaterThan(last);
      expect(wall).toContain(escape(L_NOTE_ANSWERS[id]));
      last = at;
    }
    for (const id of Object.keys(J_NOTE_HEADS)) expect(wall).not.toContain(escape(J_NOTE_HEADS[id]));
    const extras = { flags: ALL_ON, showSamples: true };
    for (const sample of [SampleJ, SampleK]) {
      const html = renderToStaticMarkup(createElement(sample, { data, siteName: 'Graylum', extras }));
      for (const id of Object.keys(J_NOTE_HEADS)) expect(html).toContain(escape(J_NOTE_HEADS[id]));
      for (const id of Object.keys(L_NOTE_HEADS)) expect(html).not.toContain(escape(L_NOTE_ANSWERS[id]));
    }
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

  it('plays step one in time: typed out, the question folded then docked, the option picked on the card and sent', () => {
    // Round seven (T2, T8): the clock decides what shows. Phases of a coach line: think, stream, (card), hold. Round
    // eleven (X1): the only card is the direction question, answered by picking its recommended option on the card.
    const lines = L_POSITIONING_MOMENTS[1].lines;
    const picture = (ms: number | null) => renderToStaticMarkup(withTrpc(createElement(PositioningPictureL,
      { moment: 1, at: ms === null ? null : momentAt(lines, ms) })));
    const [[, think], [, stream], [, card], [, hold]] = linePhases(lines[0]);
    // At the very start the coach is about to write: nothing in the conversation yet.
    const writing = picture(0);
    expect(writing).not.toContain('data-question-card');
    // Half way through writing, part of the question shows, not all of it, and no card yet.
    const half = picture(think + stream / 2);
    expect(half).toContain('前面你说了两件事');
    expect(half).not.toContain('或者说说你的想法');
    expect(half).not.toContain('data-question-card');
    // Written: first folded into one line while it is read, then docked on the message box.
    expect(picture(think + stream + card + hold * 0.1)).toContain('data-question-card="folded"');
    const open = picture(think + stream + card + hold * 0.8);
    expect(open).toContain('data-question-card="open"');
    expect(open.indexOf('data-question-card="open"')).toBeGreaterThan(open.indexOf('role="log"'));
    // The answer is not typed: the recommended option is highlighted, then pressed, on the docked card.
    expect(lines[1]).toMatchObject({ role: 'user', pick: 0, text: L_DIRECTION_CARD.options[0] });
    const [[phase, pick]] = linePhases(lines[1]);
    expect(phase).toBe('pick');
    const start = think + stream + card + hold;
    expect(picture(start + pick * 0.1)).not.toContain('data-pick=');
    const over = picture(start + pick * 0.5);
    expect(over).toContain('data-pick="0" data-state="over"');
    expect(over).not.toContain('data-message-role="user"');
    const pressed = picture(start + pick * 0.9);
    expect(pressed).toContain('data-pick="0" data-state="pressed"');
    expect(pressed).toContain('data-question-card="open"');
    expect(pressed).not.toContain('data-message-role="user"');
    // Sent: the card closes and the option's own words are the person's message; the message box stays empty.
    const sent = picture(start + pick + 10);
    expect(sent).not.toContain('data-question-card="open"');
    expect(sent).toContain('data-message-role="user"');
    expect(sent).toContain(escape(L_DIRECTION_CARD.options[0]));
    const answered = picture(null);
    expect(answered).toContain('data-message-role="user"');
    expect(answered).not.toContain('data-question-card="open"');
  });

  it('shows a question card only where the person answers by picking it: the next message is one of its options (round eleven, X1)', () => {
    const cards: Record<string, { options: readonly string[] }> = { direction: L_DIRECTION_CARD };
    const lines = L_POSITIONING_MOMENTS.flatMap(moment => moment.lines);
    const asked = lines.flatMap((line, index) => (line.role === 'coach' && line.card && !['fetch', 'table', 'plan'].includes(line.card) ? [index] : []));
    expect(asked.map(index => lines[index].card)).toEqual(['direction']);
    for (const index of asked) {
      const answer = lines[index + 1];
      const options = cards[lines[index].card!].options;
      expect(answer.role).toBe('user');
      expect(options).toContain(answer.text);
      expect(answer.pick).toBe(options.indexOf(answer.text));
    }
    // The goal and camera questions are answered in the person's own words, typed into the message box.
    const know = L_POSITIONING_MOMENTS[0].lines;
    expect(know.every(line => line.card === undefined || line.card === 'confirm')).toBe(true);
    const typed = know.filter(line => line.role === 'user');
    expect(typed.every(line => line.pick === undefined && linePhases(line)[0][0] === 'compose')).toBe(true);
    const page = renderToStaticMarkup(withTrpc(createElement(PositioningPictureL, { moment: 0, at: null })));
    expect(page).not.toContain('data-question-card');
  });

  it('orders step two as the creation Skill does: topic, title and cover, material and voice, script (round nine, V2)', () => {
    expect(L_LATER.two.stages.map(stage => stage.label)).toEqual(['选题', '标题和封面', '资料库和写作风格', '口播稿和分镜']);
    const { titles, covers, pick } = L_LATER_CHAT.cover;
    expect(titles).toHaveLength(10);
    expect(covers).toHaveLength(10);
    for (const choice of ['**#1**', '**#6**', '**#2**', '**#10**']) expect(pick).toContain(choice);
    expect(L_LATER_CHAT.voice.fields.map(([name]) => name)).toEqual(['语气', '句子长短', '开头方式', '常用表达']);
  });

  it('shows steps two and three in full, as the launched product, and the jury larger', () => {
    const on = render();
    for (const step of [L_LATER.two, L_LATER.three]) {
      expect(on).toContain(step.title);
      for (const stage of step.stages) expect(on).toContain(`${stage.label}</button>`);
    }
    // Which stages show the product's real components and which the plan: every stage says so.
    for (const stage of [...L_LATER.two.stages, ...L_LATER.three.stages]) expect(['real', 'planned']).toContain(stage.source);
    // The full launched version: no picture says a feature is not there yet.
    for (const word of ['待接入', '即将上线', '未开放', '敬请期待']) expect(on).not.toContain(word);
    expect(renderToStaticMarkup(withTrpc(createElement(PositioningPictureL, { moment: 0, at: null })))).not.toContain('待接入');
    for (const part of L_JURY.title.split(/(?<=，)/)) expect(on).toContain(part);
    expect(on).toContain(`href="${L_JURY.href}"`);
    for (const word of ['世界最强', '没有分歧', '再辩一轮', '最多两轮']) expect(on).not.toContain(word);
  });

  it('lets a visitor pick one of the 14 people and read their report overview in place (round eight, U6)', () => {
    const html = render();
    expect(L_REPORTS.length).toBe(14);
    const start = html.indexOf('id="samples-title"');
    const region = html.slice(start, html.indexOf('<h2', start + 10));
    expect(region).toContain(L_SAMPLES_REDO.title);
    for (const stat of L_SAMPLES_REDO.stats(L_REPORTS.length)) expect(region).toContain(escape(stat));
    for (const word of ['用户案例', '人物为虚构', '教练说真话', '由产品实际生成']) expect(region).not.toContain(word);
    // Every person once, in one of the four groups, as a button that shows their report.
    const grouped = L_SAMPLES_REDO.groups.flatMap(group => group.slugs) as readonly string[];
    expect([...grouped].sort()).toEqual(L_REPORTS.map(report => report.slug).sort());
    for (const report of L_REPORTS) {
      expect(region).toContain(`data-slug="${report.slug}"`);
      const [trade, aim] = L_SAMPLES_REDO.names[report.slug].split(' · ');
      const name = `<span>${escape(trade)}</span><span class="[^"]+"> · </span><span>${escape(aim)}</span>`.replace(/[()（）]/g, '.');
      expect(region).toMatch(new RegExp(`<b class="[^"]+">${name}</b><span>${escape(report.platform).replace(/[()（）+]/g, '.')}</span>`));
    }
    // Owner 2026-10-18: each named "职业或行业 · 目的（地区）".
    for (const report of L_REPORTS) expect(L_SAMPLES_REDO.names[report.slug]).toMatch(/^[^·（]+ · [^·（]+（[^）]+）$/);
    // 方向已调整 on the people whose direction the coach changed; the chosen one (the widest group) shown with 示例.
    const picker = region.slice(region.indexOf('<nav'), region.indexOf('</nav>'));
    expect(picker.split(`>${L_SAMPLES_REDO.adjusted}<`).length - 1).toBe(L_REPORTS.filter(report => report.truth).length);
    expect(region).toContain(`data-slug="${L_SAMPLES_REDO.defaultSlug}" aria-pressed="true"`);
    expect(region).toContain(`>${L_SAMPLES_REDO.sample}<`);
    expect(region).toContain(escape(SAMPLE_OVERVIEWS[L_SAMPLES_REDO.defaultSlug].positioning));
    // Round nine (V1): the whole report is behind one button, in a dialog of its own (not under the overview).
    expect(region).toContain(`${L_SAMPLES_REDO.fullReportOpen}</button>`);
    expect(region).toContain(`aria-label="${escape(L_SAMPLES_REDO.names[L_SAMPLES_REDO.defaultSlug])}`);
    expect(region).toContain(escape(L_SAMPLES_REDO.mine));
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
    expect(text).toContain(`${L_WORKFLOWS[0][0].readLabel?.[1] ?? '已读取资料库'}：${L_WORKFLOWS[0][0].read?.join('、')}`);
    expect(text).toContain(L_WORKFLOWS[0][0].calls?.[0].found);
    expect(compare).toContain('aria-label="搜索记录"');
    for (const turns of L_WORKFLOWS) {
      expect(turns.every(turn => (turn.after ?? turn.reply).includes('接下来你做') || turn === turns[0] && turns.length > 1)).toBe(true);
    }
    for (const task of L_TASKS) expect(task.coach).toContain('接下来你做');
    for (const brand of ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', '豆包', 'Kimi']) expect(text).not.toContain(brand);
  });

  it('gives every region 6 scenario work, numbers, something ready to use and a dated next step (round seven, T11)', () => {
    for (const turns of L_WORKFLOWS) {
      const all = turns.map(turn => turn.reply + (turn.after ? `\n${turn.after}` : '')).join('\n');
      expect(all).toMatch(/\n\|[^\n]+\|\n\|(-+\|)+/);
      expect(turns.some(turn => turn.read?.length || turn.calls?.length)).toBe(true);
      const last = turns[turns.length - 1];
      expect(last.after ?? last.reply).toMatch(/\*\*接下来你做\*\*：.*(今晚|明天|周[一二三四五六日])/);
    }
    // The script: about 300 characters, 9 to 11 shots, about 65 seconds, the shots' lines joined being the whole text.
    expect(SCRIPT.replace(/\n/g, '').length).toBeGreaterThan(250);
    expect(SHOTS.length).toBeGreaterThanOrEqual(9);
    expect(SHOTS.length).toBeLessThanOrEqual(11);
    const seconds = SHOTS.reduce((sum, shot) => sum + shot[4], 0);
    expect(seconds).toBeGreaterThanOrEqual(60);
    expect(seconds).toBeLessThanOrEqual(70);
    expect(SHOTS.map(shot => shot[3]).join('')).toBe(SCRIPT.replace(/\n/g, ''));
    expect(L_WORKFLOWS[2][0].proposal).toBe(SCRIPT);
    // Round twelve (D1, D2): the same video in two scenarios, the TikTok business account's rates (64 saves of 1,870
    // plays is 3.4%; 17 of 66 seconds watched is 26%; 31 of 62 is 50%).
    expect((64 / 1870) * 100).toBeCloseTo(3.4, 1);
    expect((17 / 66) * 100).toBeCloseTo(26, 0);
    expect((31 / 62) * 100).toBeCloseTo(50, 0);
    expect(L_WORKFLOWS[1][0].reply).toContain('| 冰箱剩菜三种做法 | 26% | 28% | 1.4% | 3.4% | 0.5% |');
    expect(L_WORKFLOWS[1][0].reply).toContain('| 你近 30 天平均 | 43% | 37% | 0.8% | 5.1% | 0.9% |');
    for (const line of ['| 平均观看占时长 | 26% | 43% |', '| 完播率 | 28% | 37% |', '| 评论率 | 1.4% | 0.8% |', '| 收藏率 | 3.4% | 5.1% |',
      '| 关注率 | 0.5% | 0.9% |']) expect(L_WORKFLOWS[3][0].reply).toContain(line);
    expect(L_WORKFLOWS[1][0].reply).not.toContain('2.6–2.9');
    expect(L_TASKS[3].question).toBe(L_WORKFLOWS[3][0].user);
    // Round eight (U10): the 小红书 note's four steps run 0–15 minutes without a gap, and the coach says why it is written so.
    const spans = [...(L_WORKFLOWS[0][0].proposal ?? '').matchAll(/(\d+)–(\d+) 分钟/g)].map(m => [Number(m[1]), Number(m[2])]);
    expect(spans).toEqual([[0, 4], [4, 7], [7, 11], [11, 15]]);
    expect(L_WORKFLOWS[0][0].after?.match(/^\d\. /gm)).toHaveLength(4);
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

  it('keeps the price comparison quiet, with only "无需绑卡 · 免费试用" under its button (round six)', () => {
    const html = render();
    const price = html.slice(html.indexOf('id="pricing-title"'), html.indexOf('id="faq-title"'));
    expect(price).toContain('data-quiet="true"');
    expect(price).toContain(L_PRICE_NOTE.free);
    for (const gone of ['先聊后买', '多位顶级模型再审一遍', '随时取消', '退款规则']) expect(price).not.toContain(gone);
    expect(price).not.toContain('data-plan=');
  });

  it('opens step one with the positioning Skill\'s own opening and keeps one person throughout (round six)', () => {
    const [know, diagnose] = L_POSITIONING_MOMENTS;
    expect(know.lines[0]).toMatchObject({ role: 'coach', opening: true });
    expect(know.lines[0].text.startsWith(L_SKILL_OPENING)).toBe(true);
    // The person never turns to weekend dinners on their own; the coach raises them as one of the directions.
    for (const moment of L_POSITIONING_MOMENTS) {
      for (const line of moment.lines) if (line.role === 'user') expect(line.text).not.toContain('精致大餐');
    }
    expect(diagnose.lines[0]).toMatchObject({ role: 'coach', card: 'direction' });
    // What the first summary lists, the person said before it.
    const said = know.lines.filter(line => line.role === 'user').map(line => line.text).join('');
    for (const fact of ['一年后', 'TikTok', 'Instagram', '长视频', '二十多道', '常问', '不知道该找谁', '支架']) expect(said).toContain(fact);
    const picture = renderToStaticMarkup(withTrpc(createElement(PositioningPictureL, { moment: 0, at: null })));
    expect(picture).toContain(escape(L_SKILL_OPENING));
    expect(picture).not.toContain('<h1');
  });

  it('shows only figures the connected accounts and public data really give, every cell filled (round twelve, D1–D4)', () => {
    const html = render();
    // No interface gives these: nowhere on the page, nor in what the demos type.
    const copy = JSON.stringify([L_WORKFLOWS, L_LATER_CHAT, L_LATER_FLYWHEEL, L_POSITIONING_MOMENTS, L_TASKS]);
    for (const word of ['跳出', '3 秒完播', '5 秒完播', '前 3 秒', '平台不提供', '未取到', '缺失']) {
      expect(html, word).not.toContain(word);
      expect(copy, word).not.toContain(word);
    }
    // Step three: a card per platform, only its own fields, all filled; the rates are the counts over the views.
    const { cards } = L_LATER_FLYWHEEL.monitor;
    expect(cards.map(card => card.platform)).toEqual(['TikTok', 'Instagram Reels', 'YouTube Shorts']);
    for (const card of cards) for (const [, value] of card.fields) expect(value).toMatch(/\d/);
    expect((186 / 2140) * 100).toBeCloseTo(8.7, 1);
    expect((97 / 2140) * 100).toBeCloseTo(4.5, 1);
    expect((41 / 860) * 100).toBeCloseTo(4.8, 1);
    expect((1310 * 26) / 3600).toBeCloseTo(9.5, 1);
    // Step one's benchmark table: A to G, every cell a figure; the report's chapter 5 says the same, nothing missing.
    for (const row of L_BENCHMARK_ROWS) for (const metric of Object.values(row.metrics)) expect(metric.value).not.toBeNull();
    const report = JSON.stringify(OFFICE_WORKER_REPORT);
    expect(report).toContain('约 9.7 万粉；约 2.4 万；约 7%');
    expect(report).toContain('约 2.8 万粉；约 1.1 万；约 9%');
    for (const item of SAMPLE_OVERVIEWS['office-worker'].benchmarks) expect(item.updateFreq).toMatch(/^每周 \d 条$/);
  });

  it('hangs the jury under step one, a level below it (round twelve, Owner 2026-10-18)', () => {
    const html = render();
    const steps = html.slice(html.indexOf('id="how-it-works"'), html.indexOf('id="samples-title"'));
    // Inside the steps region, after step one's window and before step two; its title an h3, no region or h2 of its own.
    const jury = steps.indexOf('id="jury-title"');
    expect(jury).toBeGreaterThan(steps.indexOf('id="step-one-title"'));
    expect(jury).toBeLessThan(steps.indexOf('aria-label="第二步'));
    expect(steps).toMatch(/<h3 id="jury-title"/);
    expect(html).not.toMatch(/<section[^>]*aria-labelledby="jury-title"/);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    // What it does in full: the bridge, four points, one note, when it is worth using, the link; the circuit beside.
    for (const text of [L_JURY.bridge, L_JURY.tier, ...L_JURY.points.flatMap(point => [point.lead, point.text]),
      L_JURY.example.where, L_JURY.whenLabel, L_JURY.when, L_JURY.link]) expect(steps).toContain(escape(text));
    expect(steps).toContain('aria-label="评审团怎么工作"');
    // True to the real jury: each changed chapter's before and after, the original kept; no brands, no credits.
    expect(L_JURY.points[2].text).toContain('每一章标出改前、改后的句子');
    for (const word of ['GPT', 'Claude', 'Gemini', '积分', '没有分歧', '再辩一轮', '最多两轮']) expect(steps).not.toContain(word);
  });

  it('keeps one button wording and a button at least every two regions', () => {
    const html = render();
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toContain('免费和教练聊聊');
    expect(header).not.toContain('>免费试用<');
    const between = (from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to)).includes('免费和教练聊聊');
    expect(between('id="voice-title"', 'id="steps-title"')).toBe(true);
    expect(between('id="jury-title"', 'id="samples-title"')).toBe(true);
    expect(between('id="compare-title"', 'id="pricing-title"')).toBe(true);
  });

  it('gives a complete storyboard: the 11 shots\' lines are the script word for word, 73 seconds in all (round six; ten)', () => {
    const { shots, proposal, total } = L_LATER_CHAT.script;
    expect(shots).toHaveLength(11);
    expect(shots.map(shot => shot[3]).join('')).toBe(proposal.replace(/\n/g, ''));
    expect(shots.reduce((sum, shot) => sum + Number.parseInt(shot[4], 10), 0)).toBe(73);
    expect(total).toBe('合计约 73 秒');
    expect(proposal.replace(/\n/g, '').length).toBeGreaterThanOrEqual(280);
    // Round ten (W3): the ending asks the viewers, no "扣 1"; anywhere on the page either.
    expect(proposal).toContain('你家冰箱里最常剩的是啥？你都是咋把它救回来的？');
    for (const word of ['扣个1', '扣1', '扣个 1']) expect(render()).not.toContain(word);
  });

  it('keeps step one strictly one message, one answer: never two from the person in a row, no line twice (round ten, W1)', () => {
    const lines = L_POSITIONING_MOMENTS.flatMap(moment => moment.lines);
    lines.forEach((line, index) => { if (line.role === 'user') expect(lines[index + 1]?.role).not.toBe('user'); });
    const texts = lines.map(line => line.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('names step two\'s third stage 资料库和写作风格 and sets the voice beside an older post on another subject (round ten, W2)', () => {
    expect(L_LATER.two.stages[2].label).toBe('资料库和写作风格');
    expect(L_LATER_CHAT.voice.original.label).toBe('你上个月发的一条（别的话题）');
    expect(L_LATER_CHAT.voice.original.text).toContain('超市');
  });

  it('draws where to post as the recommended account, or as platform marks for a person with no account yet', () => {
    const copy = L_SAMPLES_REDO.overview;
    for (const [slug, data] of Object.entries(SAMPLE_OVERVIEWS)) {
      const html = renderToStaticMarkup(createElement(OverviewL, { data }));
      if (data.ownAccount) {
        expect(html).toContain(copy.accountTag);
        expect(html).toContain(escape(data.ownAccount.displayName));
        if (!data.ownAccount.followers) expect(html).not.toContain(`<dt>${copy.accountFollowers}</dt>`);
      } else {
        expect(html, slug).toContain(copy.noAccount);
        expect(html).not.toContain(copy.accountTag);
      }
      for (const layer of data.funnel) if (layer.why) expect(html).toContain(escape(layer.why));
    }
  });

  it('plays region 6\'s four scenarios in order over the held scroll, each from its first beat (round six, S14)', () => {
    const items = L_TASKS.map((task, index) => ({ task, copy: L_SCENARIOS.items[index], turns: L_WORKFLOWS[index] }));
    const seenOrder: number[] = [];
    for (let position = 0; position < 200; position += 1) {
      const { index, beat } = scenarioAt(items, position);
      if (seenOrder.at(-1) !== index) { seenOrder.push(index); expect(beat).toBe(0); }
    }
    expect(seenOrder).toEqual([0, 1, 2, 3]);
  });

  it('keeps "14 种人" in one piece in the samples\' strip of figures', () => {
    expect(render()).toMatch(/<li>14 种人<\/li>/);
  });
});

