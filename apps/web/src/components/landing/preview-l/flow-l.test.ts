import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { L_FLOW_LATER, L_FLOW_ONE } from '@/lib/landing/landing-copy-l-flow';
import { L_LATER, L_LATER_CHAT } from '@/lib/landing/landing-copy-l-later';
import { L_POSITIONING_MOMENTS } from '@/lib/landing/landing-copy-l-positioning';
import { L_STEPS } from '@/lib/landing/landing-copy-l-steps';
import { arrivedAt, cuesAt, loopMs, loopState, LOOP_HOLD_MS, typedAt } from '@/lib/landing/loop-timeline';
import { STEP_ONE_PICTURES } from './StepOneFlowL';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
const draw = (moment: number, ms: number | null) => renderToStaticMarkup(createElement('div', null, STEP_ONE_PICTURES[moment].draw(ms)));

describe('region 3 as modules that loop by themselves (Owner 2026-11-11)', () => {
  it('gives every stage one short line: the lines the Owner approved, none longer than a sentence', () => {
    expect(L_STEPS.one.stages.map(stage => stage.note)).toEqual([
      '一次只问一个问题，清单跟着对话自动记。',
      '先直说这条路能不能赚钱、难在哪，再用真实公开数据找对标。',
      '把前两步收成一句话定位，再落到第一个月具体怎么做。',
      // The Owner's own sentence of 2026-10-18, already one line: kept whole.
      '三步都确认后，AI 教练将根据你的信息生成定制化的策略分析报告。',
    ]);
    expect(L_LATER.two.stages.map(stage => stage.note)).toEqual([
      '按你的定位和上周的数据，挑出这周最值得拍的几条。',
      '出 10 个标题和 10 种封面做法，教练标出推荐和理由。',
      '先在资料库里找资料，再按你平时说话的样子写稿。',
      '你改哪句，它就接着改哪句。',
    ]);
    expect(L_LATER.three.stages.map(stage => stage.note)).toEqual([
      // The line keeps saying which platforms are not supported.
      '一条视频一键分发到 9 个主流平台。（暂不支持中国大陆的社交媒体平台）',
      '一键获取你各个平台账号的数据。',
      '说清哪条有效、为什么，给出下周三个能直接变成选题的建议。',
    ]);
    const notes = [...L_STEPS.one.stages, ...L_LATER.two.stages, ...L_LATER.three.stages].map(stage => stage.note);
    for (const note of notes) { expect(note).not.toContain('\n'); expect(note.length, note).toBeLessThanOrEqual(40); }
    for (const lede of [L_LATER.two.lede, L_LATER.three.lede]) expect(lede).not.toContain('\n');
  });

  it('says nothing new inside the pictures: every line is cut, unchanged, out of the approved scripts', () => {
    const script = L_POSITIONING_MOMENTS.flatMap(moment => moment.lines.map(line => line.text));
    const said = [L_FLOW_ONE.know.ask, L_FLOW_ONE.know.answer, L_FLOW_ONE.diagnose.fetch, L_FLOW_ONE.plan.position, L_FLOW_ONE.plan.agree, L_FLOW_ONE.plan.summary];
    for (const line of said) expect(script.some(text => text.includes(line)), line).toBe(true);
    // The question and its answer follow each other in the script, as in the picture.
    const asked = script.findIndex(text => text.includes(L_FLOW_ONE.know.ask));
    expect(script[asked + 1].startsWith(L_FLOW_ONE.know.answer)).toBe(true);
    expect(L_LATER_CHAT.cover.pick.startsWith(L_FLOW_LATER.coverPick)).toBe(true);
    expect(L_LATER_CHAT.script.proposal.split('\n\n').length).toBeGreaterThan(L_FLOW_LATER.scriptParagraphs);
    // The storyboard's columns are the script's own, by position; the figures shown are the first of each platform's own.
    expect(L_FLOW_LATER.shotColumns.map(column => L_LATER_CHAT.script.shotHead[column])).toEqual(['镜号', '景别', '画面', '时长']);
  });

  it('plays cues one after another, holds the finished picture, and shows it finished without a clock', () => {
    const cues = [['ask', 1000], ['answer', 500]] as const;
    expect(loopMs(cues)).toBe(1500 + LOOP_HOLD_MS);
    expect(cuesAt(cues, 0)).toMatchObject({ ask: { on: true, done: false, ms: 0, share: 0 }, answer: { on: false, done: false } });
    expect(cuesAt(cues, 1200)).toMatchObject({ ask: { on: true, done: true, share: 1 }, answer: { on: true, done: false, ms: 200 } });
    // The hold: everything done, nothing moving.
    expect(cuesAt(cues, 1600)).toMatchObject({ ask: { done: true }, answer: { done: true, ms: 500, share: 1 } });
    // No clock (server HTML, reduced motion): the finished picture.
    expect(cuesAt(cues, null)).toMatchObject({ ask: { on: true, done: true, share: 1 }, answer: { on: true, done: true, share: 1 } });
    const { ask, answer } = cuesAt(cues, 300);
    expect(typedAt('一二三四五六七八九十', answer)).toBe('');
    const typed = typedAt('一二三四五六七八九十'.repeat(20), ask);
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.length).toBeLessThan(200);
    expect(typedAt('完', cuesAt(cues, null).ask)).toBe('完');
    expect([0, 1, 499, 500].map(ms => arrivedAt(3, cuesAt([['rows', 500]] as const, ms).rows))).toEqual([1, 1, 3, 3]);
    expect(arrivedAt(3, cuesAt(cues, 0).answer)).toBe(0);
  });

  it('runs only on screen in a showing tab; reduced motion never runs and shows the finished picture', () => {
    expect(loopState({ seen: true, tabShowing: true, reducedMotion: false })).toBe('playing');
    expect(loopState({ seen: false, tabShowing: true, reducedMotion: false })).toBe('paused');
    expect(loopState({ seen: true, tabShowing: false, reducedMotion: false })).toBe('paused');
    for (const seen of [true, false]) expect(loopState({ seen, tabShowing: true, reducedMotion: true })).toBe('still');
    const clock = read('use-loop-l.ts');
    // The clock reads the three signals it is decided by, and nothing listens to the page's scroll.
    for (const signal of ['IntersectionObserver', 'visibilitychange', '(prefers-reduced-motion: reduce)']) expect(clock).toContain(signal);
    for (const name of ['use-loop-l.ts', 'FlowModuleL.tsx', 'StepsL.tsx', 'StepOneFlowL.tsx', 'LaterStepsL.tsx']) {
      expect(read(name), name).not.toMatch(/addEventListener\('scroll'|scrollTo\(|scrollTop|getBoundingClientRect/);
    }
  });

  it('keeps a picture the same size whatever it shows, so nothing on the page moves while it plays', () => {
    const css = read('flow-l.module.css');
    expect(css).toMatch(/\.picture \{[^}]*height: 400px;[^}]*overflow: hidden;[^}]*contain: layout paint;/);
    expect(css).toMatch(/@media \(max-width: 859px\) \{ \.picture \{ height: 380px; \} \}/);
    // What it holds is laid out inside it, out of the page's flow.
    expect(css).toMatch(/\.feed \{ position: absolute; inset: 0;/);
    // What no longer fits is moved by a transform, never by layout, and a table being written keeps its columns where
    // they are (measured 2026-11-11: with columns sized by the text typed so far, the two modules with tables alone
    // made the region's layout shift 0.07 to 0.10; with fixed columns the whole region is under 0.02).
    expect(css).toMatch(/\.feed > div \{[^}]*transform: translateY\(min\(0px, 100cqh - 100%\)\);/);
    expect(css).toMatch(/\.work\.work table \{[^}]*table-layout: fixed;/);
    expect(css).toMatch(/\.work \.shots th:last-child \{ width: [\d.]+em; \}/);
    // One under another on a phone, side by side from 860px.
    expect(css).toMatch(/@media \(min-width: 860px\) \{\s*\.grid \{ grid-template-columns: repeat\(2,/);
  });

  it('draws step one\'s pictures from the clock: the answer after the question, the table after the searches, the report after the button', () => {
    const start = draw(0, 0);
    expect(start).not.toContain('data-message-role="user"');
    expect(start).not.toContain('下班晚、累、外卖贵');
    const done = draw(0, null);
    expect(done).toContain(L_FLOW_ONE.know.answer);
    // The checklist wrote the answer down, and still has what the question before gave it.
    expect(done).toContain('下班晚、累、外卖贵');
    expect(done).toContain('做副业，不辞职');
    expect(draw(0, STEP_ONE_PICTURES[0].totalMs - 1)).toBe(done);

    expect(draw(1, 0)).not.toContain('aria-label="搜索记录"');
    const searching = draw(1, 2500);
    expect(searching).toContain('aria-label="搜索记录"');
    // The record names the accounts it fetches (A–E); the table's own rows (down to the reference account G) come after.
    expect(searching).not.toContain('对标账号 G');
    expect(draw(1, null)).toContain('对标账号 G');
    expect(draw(1, null)).not.toContain('aria-label="搜索记录"');

    expect(draw(2, 0)).not.toContain('aria-label="本步小结卡"');
    expect(draw(2, null)).toContain('aria-label="本步小结卡"');

    const pressing = draw(3, 100);
    expect(pressing).toContain('data-on=""');
    expect(pressing).not.toContain('完整运营策略报告');
    const written = draw(3, null);
    expect(written).toContain('完整运营策略报告');
    expect(written).not.toContain('data-on=""');
    expect(written).not.toContain('正在写报告');
    // Every picture's loop is a few seconds, hold included.
    for (const picture of Object.values(STEP_ONE_PICTURES)) { expect(picture.totalMs).toBeGreaterThan(5000); expect(picture.totalMs).toBeLessThan(12000); }
  });
});
