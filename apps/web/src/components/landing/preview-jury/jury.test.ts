import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/(zh-hans)/landing/preview/jury/page';
import {
  ADOPT_ERROR_LABEL, choosable, firstSentence, isComplete, keyPoints, linkedGroup, mockConfirm, mockPropose, needsConfirm, setConfirmed, setUse, toChoices, unconfirmedSections, type ChoiceState,
} from './jury-adopt';
import {
  DEFAULT_SEAT_NAMES, resolveSeatNames, SAMPLE_PANEL, SEAT_NAME_MAX, summarize, type JuryEvent,
} from './jury-events';
import { DOC_HEAD, deskAt, type MarginItem } from './jury-desk';
import { canvasAt, statusWord } from './jury-canvas';
import { briefScenes } from './jury-brief';
import { caseFromEvents } from './jury-case';
import { JuryCanvasPlayer } from './JuryCanvasPlayer';
import { diffText } from './jury-diff';
import { REVISION_TEXT } from './jury-mock-rulings';
import { REPORT_CHAPTERS } from './jury-report';
import { seatInitials } from './JuryBits';
import { failedSeatsAt } from './jury-progress';
import { buildScenes, playbackLength, skippedStages, stageIndex } from './jury-scenes';
import { findScenario, JURY_SCENARIOS } from './jury-scripts';
import { REPORT_SECTIONS } from './jury-mock-reviews';
import { JuryReader } from './JuryReader';
import { JuryReaderChapter } from './JuryReaderChapter';
import { changeHunks, sentences } from './jury-hunks';
import { remainingMs, remainingText, totalText } from './jury-eta';
import { readerChapters, readingMinutes, summaryLines } from './jury-reader';
import { JuryStatic } from './JuryStatic';

const events = (id: string): JuryEvent[] => findScenario(id).arrivals.flatMap(arrival => arrival.events);
const MODEL_NAMES = /claude|gpt|gemini|sonnet|opus|deepseek|qwen|llama|mistral/i;

describe('jury prototype page', () => {
  it('is never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
  });
});

describe('mock data follows FUSION-REVIEW §2.2a (contract v6)', () => {
  it('gives every event a unique id and keeps event text to 120 characters, while the detail keeps the full text', () => {
    for (const scenario of JURY_SCENARIOS) {
      const list = events(scenario.id);
      expect(new Set(list.map(event => event.id)).size).toBe(list.length);
      for (const event of list) {
        for (const value of Object.values(event)) {
          if (typeof value === 'string') expect(Array.from(value).length).toBeLessThanOrEqual(120);
        }
      }
    }
    const longest = Math.max(...JSON.stringify(findScenario('full').detail).split('"').map(part => Array.from(part).length));
    expect(longest).toBeGreaterThan(120);
  });

  it('derives every event summary from the full record by the 120-character rule', () => {
    const detail = findScenario('full').detail;
    const issues = detail.seats.flatMap(seat => seat.rounds.flatMap(round => round.issues ?? []));
    for (const event of events('full')) {
      if (event.type !== 'issue') continue;
      const source = issues.find(item => summarize(item.problem) === event.problem);
      expect(source?.location).toBe(event.section);
      expect(summarize(source?.suggestion ?? '')).toBe(event.fix);
    }
    expect(summarize('字'.repeat(130))).toHaveLength(120);
    expect(summarize('字'.repeat(130)).endsWith('…')).toBe(true);
  });

  it('delivers each reviewer\'s answer together, 10–30 s after it started', () => {
    for (const scenario of JURY_SCENARIOS) {
      const started = new Map<string, number>();
      for (const arrival of scenario.arrivals) {
        for (const event of arrival.events) {
          if (event.type === 'reviewer_started') started.set(`${event.round}${event.reviewer}`, arrival.atMs);
          if (['decision', 'issue', 'response', 'reviewer_failed'].includes(event.type) && 'reviewer' in event && 'round' in event) {
            const wait = arrival.atMs - (started.get(`${event.round}${event.reviewer}`) ?? Infinity);
            expect(wait).toBeGreaterThanOrEqual(10_000);
            expect(wait).toBeLessThanOrEqual(30_000);
          }
        }
      }
    }
  });

  it('lists the changed chapters, with full original and revised text only for them', () => {
    for (const id of ['full', 'consensus'] as const) {
      const { detail } = findScenario(id);
      const ready = events(id).find(event => event.type === 'revision_ready_for_choice');
      const changed = choosable(detail.summary.sections).map(item => item.section);
      expect(ready?.type === 'revision_ready_for_choice' && ready.changedSectionTitles).toEqual(changed);
      expect(detail.awaitingChoice).toBe(true);
      expect(detail.adoption).toBeNull();
      for (const section of detail.summary.sections) {
        expect(Boolean(section.original && section.revised)).toBe(section.changed);
        for (const ruling of section.rulings) expect(ruling.opinion && ruling.reason && ruling.fix).toBeTruthy();
      }
      expect(detail.summary.sections.at(-1)?.section).toBe('全文');
    }
  });

  it('has no disagreement or response when the reviewers agree, and no ruling when the revision fails', () => {
    const consensus = events('consensus').map(event => event.type);
    expect(consensus).not.toContain('disagreement');
    expect(consensus).not.toContain('response');
    const failed = events('failed').map(event => event.type);
    expect(failed).toContain('revision_failed');
    expect(failed).not.toContain('adjudication');
    expect(findScenario('failed').detail.summary.status).toBe('failed');
  });

  it('invents no outcome metrics and names no model', () => {
    const words = JSON.stringify(JURY_SCENARIOS);
    expect(words).not.toMatch(/\d+(\.\d+)?\s*(%|万|k\b|\$|美元|元|粉|播放)/);
    expect(words).not.toMatch(MODEL_NAMES);
  });
});

describe('one stage at a time', () => {
  it('never starts a scene before what it shows has arrived, and plays scenes back to back in stage order', () => {
    for (const scenario of JURY_SCENARIOS) {
      const scenes = buildScenes(scenario.arrivals);
      const arrival = new Map(scenario.arrivals.flatMap(item => item.events.map(event => [event.id, item.atMs] as const)));
      scenes.forEach((scene, index) => {
        if (index > 0) {
          expect(scene.start).toBeGreaterThanOrEqual(scenes[index - 1].end);
          expect(stageIndex(scene.stage)).toBeGreaterThanOrEqual(stageIndex(scenes[index - 1].stage));
        }
        const shown = scene.kind === 'critique' ? scene.issues : scene.kind === 'response' ? [scene.response]
          : scene.kind === 'ruling' ? [scene.ruling] : scene.kind === 'divergence' ? [scene.split] : [];
        for (const event of shown) expect(scene.start).toBeGreaterThanOrEqual(arrival.get(event.id) ?? Infinity);
      });
    }
  });

  it('runs long enough to read at 1× and fits a 2–4 minute review; agreeing early is shorter and skips the debate', () => {
    const length = (id: string) => playbackLength(buildScenes(findScenario(id).arrivals));
    expect(length('full')).toBeGreaterThan(150_000);
    expect(length('full')).toBeLessThan(260_000);
    expect(length('consensus')).toBeLessThan(length('full'));
    expect(skippedStages(buildScenes(findScenario('consensus').arrivals))).toEqual(['debate']);
  });

  it('shows reviewers reading until their answer arrives, and greys out a reviewer who failed', () => {
    const scenes = buildScenes(findScenario('full').arrivals);
    expect(deskAt(scenes, 10_000).reading.A).toBeTruthy();
    expect(Object.values(deskAt(scenes, 10_000).reading)).toContain(deskAt(scenes, 10_000).focus);
    expect(deskAt(scenes, 22_500).reading.A).toBeUndefined();
    expect(statusWord(canvasAt(scenes, 22_500, DEFAULT_SEAT_NAMES), 'A')).toBe('已交卷');
    const failedScenes = buildScenes(findScenario('failed').arrivals);
    const end = playbackLength(failedScenes);
    expect(failedSeatsAt(failedScenes, end)).toEqual(['B']);
    expect(statusWord(canvasAt(failedScenes, end, DEFAULT_SEAT_NAMES), 'B')).toBe('未计入');
    expect(failedScenes.some(scene => scene.kind === 'failed' && scene.failure.reviewer === 'B')).toBe(true);
  });
});

describe('the annotated report', () => {
  const scenes = buildScenes(findScenario('full').arrivals);
  const kinds = (items: MarginItem[] | undefined) => (items ?? []).map(item => item.kind);
  const at = (test: (scene: (typeof scenes)[number]) => boolean, offset = 1) => (scenes.find(test)?.start ?? 0) + offset;

  it('moves readers only down the report, so the stage never scrolls back to the top mid-read', () => {
    const order = REPORT_CHAPTERS.map(chapter => chapter.title);
    const reading = scenes.filter(scene => scene.kind === 'reading');
    for (const scene of reading) {
      let last = -1;
      for (let clock = scene.start; clock < scene.end; clock += 500) {
        const focus = deskAt(scenes, clock).focus;
        if (focus === null) continue;
        expect(order.indexOf(focus)).toBeGreaterThanOrEqual(last);
        last = order.indexOf(focus);
      }
    }
  });

  it('pins each issue to the margin of its own chapter, and points the stage at that chapter', () => {
    const critique = scenes.filter(scene => scene.kind === 'critique').at(-1);
    if (critique?.kind !== 'critique') throw new Error('expected a critique');
    const view = deskAt(scenes, critique.end - 1);
    for (const issue of critique.issues) {
      expect(view.notes[issue.section]?.some(item => item.kind === 'issue' && item.issue.id === issue.id)).toBe(true);
    }
    expect(view.focus).toBe(critique.issues.at(-1)?.section);
  });

  it('opens one key decision at a time beside its chapter, the earlier ones folded', () => {
    const view = deskAt(scenes, at(scene => scene.kind === 'steelman' && scene.index === 2, 3_000));
    const platform = view.notes['第 6 章 平台选择']?.find(item => item.kind === 'decision');
    const positioning = view.notes['第 2 章 定位一句话']?.find(item => item.kind === 'decision');
    expect(platform?.kind === 'decision' && platform.open).toBe(true);
    expect(positioning?.kind === 'decision' && positioning.open).toBe(false);
    expect(view.notes['第 10 章 变现路径']).toBeUndefined();
  });

  it('puts the two sides of a split side by side, and threads the round-2 replies under it', () => {
    const lastReply = scenes.filter(scene => scene.kind === 'response').at(-1);
    const view = deskAt(scenes, (lastReply?.end ?? 0) - 1);
    const split = view.notes['第 6 章 平台选择']?.find(item => item.kind === 'split');
    if (split?.kind !== 'split') throw new Error('expected a split');
    expect(split.split.keep).toEqual(['B', 'C']);
    expect(split.replies.length).toBeGreaterThan(0);
    expect(split.replies.every(reply => reply.response.decision === 'platform')).toBe(true);
  });

  it('stamps adopted or not on the notes it rules on, then shows the redline of changed chapters', () => {
    const ruling = scenes.filter(scene => scene.kind === 'ruling').at(-1);
    const view = deskAt(scenes, (ruling?.end ?? 0) - 1);
    const salt = view.notes['第 2 章 定位一句话']?.find(item => item.kind === 'issue');
    expect(salt?.kind === 'issue' && salt.stamp).toBe(false);
    expect(kinds(view.notes['第 12 章 30 天行动'])).toContain('ruling');
    const end = deskAt(scenes, playbackLength(scenes) - 1);
    expect(end.focus).toBe(end.redline.at(-1));
    expect(end.redline).toEqual(choosable(findScenario('full').detail.summary.sections).map(item => item.section));
    const failed = buildScenes(findScenario('failed').arrivals);
    const failedEnd = deskAt(failed, playbackLength(failed) - 1);
    expect(failedEnd.revisionFailed).toBe(true);
    expect(failedEnd.redline).toEqual([]);
    expect(failedEnd.focus).toBe(DOC_HEAD);
    const writing = scenes.find(scene => scene.kind === 'writing');
    if (!writing) throw new Error('expected a writing scene');
    expect(deskAt(scenes, writing.end - 1).reading.S).toBe(REPORT_CHAPTERS.at(-1)?.title);
  });

  it('shows every note and ruling at once for reduced motion', () => {
    const view = deskAt(scenes, 0, true);
    const all = Object.values(view.notes).flat();
    expect(all.filter(item => item.kind === 'issue')).toHaveLength(events('full').filter(event => event.type === 'issue').length);
    expect(all.filter(item => item.kind === 'ruling')).toHaveLength(events('full').filter(event => event.type === 'adjudication').length);
    expect(all.filter(item => item.kind === 'split')).toHaveLength(2);
  });

  it('marks deletions and additions so that each side rebuilds its own text', () => {
    for (const { original, revised } of Object.values(REVISION_TEXT)) {
      const parts = diffText(original, revised);
      expect(parts.filter(part => part.type !== 'ins').map(part => part.text).join('')).toBe(original);
      expect(parts.filter(part => part.type !== 'del').map(part => part.text).join('')).toBe(revised);
    }
  });
});

describe('seat marks', () => {
  it('uses the first character of each name, falls back to seat letters when two collide, and keeps the summary apart', () => {
    expect(seatInitials(DEFAULT_SEAT_NAMES)).toEqual({ A: 'A', B: 'B', C: 'C', S: '汇' });
    expect(seatInitials(resolveSeatNames(SAMPLE_PANEL))).toEqual({ A: '专', B: '较', C: '看', S: '首' });
    expect(seatInitials({ A: 'mia', B: 'Noah', C: 'Ivy', S: 'lead' })).toEqual({ A: 'M', B: 'N', C: 'I', S: 'L' });
  });
});

describe('chapter-by-chapter choice', () => {
  const sections = findScenario('full').detail.summary.sections;

  it('switches linked chapters together, both ways', () => {
    expect(linkedGroup(sections, '第 10 章 变现路径')).toEqual(['第 10 章 变现路径', '第 12 章 30 天行动']);
    const state = setUse({}, sections, '第 12 章 30 天行动', 'revised');
    expect(state['第 10 章 变现路径']?.use).toBe('revised');
  });

  it('asks for the no-fact-change confirmation only when adopting a wording-only chapter', () => {
    const wording = sections.find(item => item.wordingOnly);
    expect(wording).toBeDefined();
    let state: ChoiceState = setUse({}, sections, wording!.section, 'revised');
    expect(needsConfirm(wording!, state)).toBe(true);
    state = setConfirmed(state, wording!.section, true);
    expect(needsConfirm(wording!, state)).toBe(false);
    expect(needsConfirm(wording!, setUse({}, sections, wording!.section, 'original'))).toBe(false);
  });

  it('names the chapter that is picked but not yet confirmed, so "5/6" is explained (B10B-08)', () => {
    let state: ChoiceState = {};
    for (const item of choosable(sections)) state = setUse(state, sections, item.section, 'revised');
    const waiting = unconfirmedSections(state, sections);
    expect(waiting).toEqual(choosable(sections).filter(item => item.wordingOnly).map(item => item.section));
    expect(waiting.length).toBeGreaterThan(0);
    expect(isComplete(state, sections)).toBe(false);
    for (const name of waiting) state = setConfirmed(state, name, true);
    expect(unconfirmedSections(state, sections)).toEqual([]);
    expect(isComplete(state, sections)).toBe(true);
  });

  it('is complete only when every changed chapter is chosen, and builds the adopt request from it', () => {
    let state: ChoiceState = {};
    for (const item of choosable(sections)) state = setUse(state, sections, item.section, 'original');
    expect(isComplete(state, sections)).toBe(true);
    expect(mockPropose(sections, toChoices(state, sections))).toMatchObject({ state: 'recorded', versionId: null, adopted: [] });
    state = setUse(state, sections, '第 3 章 差异化', 'revised');
    expect(isComplete(state, sections)).toBe(false);
    state = setConfirmed(state, '第 3 章 差异化', true);
    const choices = toChoices(state, sections);
    expect(choices.find(item => item.section === '第 3 章 差异化')).toEqual({ section: '第 3 章 差异化', use: 'revised', confirmedNoFactChange: true });
    expect(choices.every(item => sections.find(section => section.section === item.section)?.changed)).toBe(true);
    const proposal = mockPropose(sections, choices);
    expect(proposal).toMatchObject({ state: 'proposed', adopted: ['第 3 章 差异化'] });
    if (proposal.state !== 'proposed') throw new Error('expected a proposal');
    expect(proposal.diff.changes).toHaveLength(0);
    expect(mockConfirm(proposal, 'apply').versionId).toBe('mock-version');
    expect(mockConfirm(proposal, 'decline')).toMatchObject({ state: 'recorded', versionId: null });
  });

  it('shows the field changes and the steps confirmed with them before anything changes', () => {
    let state: ChoiceState = {};
    for (const item of choosable(sections)) state = setUse(state, sections, item.section, 'original');
    state = setUse(state, sections, '第 10 章 变现路径', 'revised');
    const proposal = mockPropose(sections, toChoices(state, sections));
    if (proposal.state !== 'proposed') throw new Error('expected a proposal');
    expect(proposal.adopted).toEqual(['第 10 章 变现路径', '第 12 章 30 天行动']);
    expect(proposal.diff.changes.map(item => item.fieldTitle)).toEqual(['第一步怎么赚钱', '更新节奏']);
    expect(proposal.diff.cascade.length).toBeGreaterThan(0);
  });

  it('counts every chapter not adopted as kept, unchanged ones included, like the server', () => {
    let state: ChoiceState = {};
    for (const item of choosable(sections)) state = setUse(state, sections, item.section, 'original');
    state = setUse(state, sections, '第 10 章 变现路径', 'revised');
    const proposal = mockPropose(sections, toChoices(state, sections));
    if (proposal.state !== 'proposed') throw new Error('expected a proposal');
    const chapters = sections.filter(item => item.section !== '全文').length;
    expect(proposal.kept).toHaveLength(chapters - proposal.adopted.length);
    expect(proposal.kept).not.toContain('全文');
    expect(mockConfirm(proposal, 'apply').kept).toEqual(proposal.kept);
  });

  it('explains every refusal code in plain words', () => {
    for (const code of ['FUSION_ADOPTION_INCOMPLETE', 'FUSION_ADOPTION_INVALID', 'FUSION_ADOPTION_CONFIRM_REQUIRED', 'FUSION_ADOPTION_LINKED',
      'FUSION_ADOPTION_STALE', 'FUSION_REVIEW_ADOPTED', 'REPORT_REVISION_STALE']) {
      expect(ADOPT_ERROR_LABEL[code]).toBeTruthy();
    }
  });
});

describe('seat names and static rendering', () => {
  it('defaults to 评审 A/B/C and 汇总, and takes names from the panel up to 20 characters', () => {
    expect(resolveSeatNames(undefined)).toEqual(DEFAULT_SEAT_NAMES);
    const sample = resolveSeatNames(SAMPLE_PANEL);
    expect(Array.from(sample.A)).toHaveLength(SEAT_NAME_MAX);
    expect(sample.S).toBe('首席主笔');
    const tooLong = resolveSeatNames({ ...SAMPLE_PANEL, reviewers: [{ seat: 'B', name: '名'.repeat(SEAT_NAME_MAX + 1) }] });
    expect(tooLong.B).toBe(DEFAULT_SEAT_NAMES.B);
  });

  it('renders the reduced-motion version with one record per person, the configured names and no model names', () => {
    for (const scenario of JURY_SCENARIOS) {
      const scenes = buildScenes(scenario.arrivals);
      const html = renderToStaticMarkup(createElement(JuryStatic, {
        scenes, detail: scenario.detail, names: resolveSeatNames(SAMPLE_PANEL), skipped: skippedStages(scenes), onOpenRecord: () => {},
      }));
      expect(html.match(/id="record-[ABCS]"/g)).toHaveLength(4);
      expect(html).toContain('专门挑刺的资深短视频运营与商业变现老顾问');
      expect(html).not.toMatch(MODEL_NAMES);
    }
  });

  it('opens with 30 秒看懂, shows changed chapters open with their choice and the rest as one line', () => {
    const { detail } = findScenario('full');
    const html = renderToStaticMarkup(createElement(JuryReader, { detail, names: DEFAULT_SEAT_NAMES }));
    const changed = choosable(detail.summary.sections);
    expect(html).toContain('30 秒看懂');
    for (const line of summaryLines(detail)) expect(html).toContain(line.text);
    expect(summaryLines(detail)).toHaveLength(4);
    expect(html).toContain(`评审改了 ${changed.length} 章，最重要的 3 条`);
    for (const point of keyPoints(detail, REPORT_SECTIONS)) expect(html).toContain(point.text);
    expect(html).toContain(`已选 0/${changed.length}`);
    expect(html).toContain(`预计阅读约 ${readingMinutes(detail, readerChapters(detail))} 分钟`);
    expect(html.match(/采用修订版/g)?.length).toBe(changed.length);
    expect(html).toContain('只看改动');
    expect(html).toContain('确认');
    // An unchanged chapter is one line: its title and what it says, no full text.
    expect(html).toContain('第 5 章 同类账号');
    expect(html.match(/看这一章全文/g) ?? []).toHaveLength(0);
    const chapter = readerChapters(detail).find(item => !item.section?.changed && !item.issues.length);
    if (!chapter) throw new Error('expected an unchanged chapter');
    const full = renderToStaticMarkup(createElement(JuryReaderChapter, {
      chapter, names: DEFAULT_SEAT_NAMES, adoption: null, compact: false, open: true, onToggle: () => {},
    }));
    expect(full).not.toContain('收起');
    // 看全文 shows the whole report: the chapter's own text in place, not behind a fold.
    expect(full).toContain(chapter.body);
    expect(full).not.toContain('看这一章全文');
    const failedDetail = findScenario('failed').detail;
    const failed = renderToStaticMarkup(createElement(JuryReader, { detail: failedDetail, names: DEFAULT_SEAT_NAMES }));
    expect(failed).toContain('修订稿没有生成成功，原文没有任何改动');
    expect(failed).not.toContain('采用修订版');
    expect(failed).not.toContain('已选 0/');
    expect(keyPoints(failedDetail, REPORT_SECTIONS)[0]?.text).toBeTruthy();
  });

  it('shows only the changed sentences of a chapter, one sentence of context around each, the rest folded', () => {
    for (const { original, revised } of Object.values(REVISION_TEXT)) {
      const hunks = changeHunks(original, revised);
      expect(hunks.some(hunk => hunk.type === 'change')).toBe(true);
      const rebuilt = (side: 'before' | 'after') => hunks.map(hunk => (hunk.type === 'change' ? hunk[side] : hunk.text)).join('');
      expect(rebuilt('before')).toBe(sentences(original).join(''));
      expect(rebuilt('after')).toBe(sentences(revised).join(''));
    }
    const money = changeHunks(REVISION_TEXT['第 10 章 变现路径'].original, REVISION_TEXT['第 10 章 变现路径'].revised);
    expect(money.map(hunk => hunk.type)).toEqual(['folded', 'context', 'change', 'context', 'context']);
    expect(money[0]).toMatchObject({ type: 'folded', count: 2 });
  });

  it('estimates the time left from the measured parts, never going up', () => {
    const full = buildScenes(findScenario('full').arrivals);
    const consensus = buildScenes(findScenario('consensus').arrivals);
    expect(remainingMs(full, 0)).toBe(210_000);
    expect(remainingMs(consensus, 0)).toBe(150_000);
    expect(totalText(full)).toBe('约 3–4 分钟');
    expect(totalText(consensus)).toBe('约 2–3 分钟');
    let last = Infinity;
    for (let clock = 0; clock <= playbackLength(full); clock += 1000) {
      const left = remainingMs(full, clock);
      expect(left).toBeLessThanOrEqual(last);
      last = left;
    }
    expect(remainingMs(full, playbackLength(full))).toBe(0);
    expect(remainingText(150_000)).toBe('还剩约 2 分 30 秒');
    expect(remainingText(120_000)).toBe('还剩约 2 分钟');
    expect(remainingText(41_000)).toBe('还剩约 50 秒');
    expect(remainingText(5_000)).toBe('马上就好');
  });

  it('ranks debated rulings first among the key points, and cuts a chapter\'s reason to its first sentence', () => {
    const { detail } = findScenario('full');
    const adopted = detail.summary.sections.flatMap(item => item.rulings).filter(item => item.adopted);
    const top = keyPoints(detail, REPORT_SECTIONS)[0];
    expect(adopted.find(item => item.opinion === top.text)?.disputed).toBe(adopted.some(item => item.disputed));
    expect(firstSentence('先这样。再那样。')).toBe('先这样。');
    expect(firstSentence('只有一句')).toBe('只有一句');
  });
});

describe('the canvas', () => {
  const scenes = buildScenes(findScenario('full').arrivals);
  const names = DEFAULT_SEAT_NAMES;

  it('lights one thing at a time and says it in one short sentence that names no model', () => {
    for (const scenario of JURY_SCENARIOS) {
      const list = buildScenes(scenario.arrivals);
      for (let clock = 0; clock < playbackLength(list); clock += 1000) {
        const view = canvasAt(list, clock, resolveSeatNames(SAMPLE_PANEL));
        expect(view.caption).not.toMatch(MODEL_NAMES);
        expect(Array.from(view.caption).length).toBeLessThanOrEqual(64);
        for (const seat of ['A', 'B', 'C', 'S'] as const) expect(view.columns[seat].length).toBeLessThanOrEqual(6);
      }
    }
  });

  it('says what each reviewer is doing now in the word under its mark, also while the second round reads', () => {
    const second = scenes.find(scene => scene.kind === 'reading' && scene.round === 2);
    if (second?.kind !== 'reading') throw new Error('expected a second reading round');
    const view = canvasAt(scenes, second.start + 1, names);
    for (const seat of ['A', 'B', 'C'] as const) {
      expect(statusWord(view, seat)).toBe('在读');
      expect(view.columns[seat].at(-1)?.key).toBe('read-2');
      expect(view.columns[seat].some(card => card.key === 'read-1')).toBe(false);
    }
    expect(statusWord(canvasAt(scenes, second.end - 1, names), 'A')).toBe('已交卷');
  });

  it('threads each reviewer to the report while reading, and shows only the current issue in words', () => {
    const reading = canvasAt(scenes, 10_000, names);
    expect(reading.doc.state).toBe('reading');
    expect(reading.next.state).toBe('none');
    expect(reading.edges.every(edge => edge.from === 'doc')).toBe(true);
    const critique = scenes.find(scene => scene.kind === 'critique');
    if (critique?.kind !== 'critique') throw new Error('expected a critique');
    const during = canvasAt(scenes, critique.end - 1, names);
    const card = during.columns[critique.seat].find(item => item.kind === 'issues');
    expect(card?.kind === 'issues' && card.shown).toBe(critique.issues.length);
    expect(card?.kind === 'issues' && card.line).toBeTruthy();
    expect(during.focus).toEqual([critique.seat]);
    const after = canvasAt(scenes, critique.end + 1, names).columns[critique.seat].find(item => item.kind === 'issues');
    expect(after?.kind === 'issues' && after.line).toBeNull();
  });

  it('draws a split between the two sides of a disagreement, and turns a stance when a reply changes the verdict', () => {
    const divergence = scenes.find(scene => scene.kind === 'divergence');
    if (divergence?.kind !== 'divergence') throw new Error('expected a divergence');
    const view = canvasAt(scenes, divergence.start + 1, names);
    const { keep, change } = divergence.split;
    expect(view.edges).toHaveLength(keep.length * change.length);
    expect(view.edges.every(edge => edge.tone === 'split' && keep.includes(edge.from as never) && change.includes(edge.to as never))).toBe(true);
    const splits = scenes.flatMap(scene => (scene.kind === 'divergence' ? [scene.split] : []));
    const sideOf = (seat: string, decision: string) => (splits.find(item => item.decision === decision)?.keep.includes(seat as never) ? 'keep' : 'change');
    const turn = scenes.find(scene => scene.kind === 'response' && scene.verdictNow !== null
      && sideOf(scene.response.reviewer, scene.response.decision) !== scene.verdictNow);
    if (turn?.kind !== 'response') throw new Error('expected a reply that changes a verdict');
    const card = canvasAt(scenes, turn.end - 1, names).columns[turn.response.reviewer].find(item => item.kind === 'stances');
    expect(card?.kind === 'stances' && card.items.find(item => item.decision === turn.response.decision)?.turned).toBe(true);
  });

  it('threads the summary to each result only once it writes, then writes the revision as a new report under it', () => {
    const end = canvasAt(scenes, playbackLength(scenes) - 1, names);
    const rulings = events('full').filter(event => event.type === 'adjudication');
    const card = end.columns.S.find(item => item.kind === 'rulings');
    expect(card?.kind === 'rulings' && card.total).toBe(rulings.length);
    expect(card?.kind === 'rulings' && card.adopted).toBe(rulings.filter(event => event.type === 'adjudication' && event.adopted).length);
    expect(end.next).toEqual({ state: 'revised', changed: choosable(findScenario('full').detail.summary.sections).length });
    expect(end.doc.state).toBe('waiting');
    expect(end.edges).toEqual([{ from: 'S', to: 'next', tone: 'live' }]);
    const writing = scenes.find(scene => scene.kind === 'writing');
    if (!writing) throw new Error('expected a writing scene');
    for (let clock = 0; clock < writing.start; clock += 500) {
      const before = canvasAt(scenes, clock, names);
      expect(before.joined).toEqual([]);
      expect(before.edges.some(edge => edge.from === 'S' || edge.to === 'S')).toBe(false);
    }
    expect(canvasAt(scenes, writing.start + 1, names).joined).toEqual(['A']);
    const joined = canvasAt(scenes, writing.end - 1, names);
    expect(joined.joined).toEqual(['A', 'B', 'C']);
    expect(joined.edges.map(edge => `${edge.from}>${edge.to}`)).toEqual(['A>S', 'B>S', 'C>S']);
    expect(end.joined).toEqual(['A', 'B', 'C']);
    const failedEnd = canvasAt(buildScenes(findScenario('failed').arrivals), Infinity, names);
    expect(failedEnd.joined).toEqual(['A', 'C']);
    const failed = buildScenes(findScenario('failed').arrivals);
    const unchanged = canvasAt(failed, playbackLength(failed) - 1, names);
    expect(unchanged.next.state).toBe('unchanged');
    expect(unchanged.edges).toEqual([]);
    const consensus = buildScenes(findScenario('consensus').arrivals);
    expect(consensus.some(scene => scene.kind === 'response')).toBe(false);
  });
});

describe('the canvas for embedding', () => {
  const played = (list: ReturnType<typeof briefScenes>) => list.filter(scene => scene.end > scene.start);

  it('plays only the key moments in the short version, back to back from zero, and ends where the full one ends', () => {
    for (const scenario of JURY_SCENARIOS) {
      const full = buildScenes(scenario.arrivals);
      const brief = briefScenes(full);
      expect(brief[0]?.start).toBe(0);
      brief.forEach((scene, index) => {
        if (index > 0) expect(scene.start).toBe(brief[index - 1].end);
      });
      expect([...new Set(played(brief).map(scene => scene.stage))]).toEqual(['seated', 'reading', 'divergence', 'ruling', 'revision']);
      expect(played(brief).filter(scene => scene.kind === 'divergence' || scene.kind === 'agreed')).toHaveLength(1);
      expect(played(brief).filter(scene => scene.kind === 'ruling').length).toBeLessThanOrEqual(3);
      expect(brief.filter(scene => scene.kind === 'ruling')).toHaveLength(full.filter(scene => scene.kind === 'ruling').length);
      expect(playbackLength(brief)).toBeLessThan(playbackLength(full) / 3);
      const end = canvasAt(brief, playbackLength(brief) - 1, DEFAULT_SEAT_NAMES);
      const fullEnd = canvasAt(full, playbackLength(full) - 1, DEFAULT_SEAT_NAMES);
      expect(end.next).toEqual(fullEnd.next);
      expect(end.joined).toEqual(fullEnd.joined);
      for (const seat of ['A', 'B', 'C', 'S'] as const) expect(end.columns[seat].at(-1)).toEqual(fullEnd.columns[seat].at(-1));
      for (let clock = 0; clock < playbackLength(brief); clock += 500) {
        const view = canvasAt(brief, clock, DEFAULT_SEAT_NAMES);
        if (view.stage !== 'reading') expect(Object.values(view.columns).flat().some(card => card.kind === 'read' && card.state === 'reading')).toBe(false);
      }
    }
  });

  it('freezes at the given progress, plays the passed-in case, and names no model', () => {
    const report = { title: '定位报告：示例人物', excerpt: '开头两行。', chapters: 9, revisedExcerpt: '修订后的开头。' };
    const data = caseFromEvents(report, events('full'));
    const at = (progress: number) => renderToStaticMarkup(createElement(JuryCanvasPlayer, {
      data, progress, brief: true, names: resolveSeatNames(SAMPLE_PANEL),
    }));
    const start = at(0);
    const end = at(1);
    expect(start).toContain('定位报告：示例人物');
    expect(start).toContain('9 章');
    expect(start).not.toContain('修订后的定位报告：示例人物');
    expect(end).toContain('修订后的定位报告：示例人物');
    expect(end).toContain('修订后的开头。');
    expect(end).toContain('专门挑刺的资深短视频运营与商业变现老顾问');
    expect(at(-1)).toBe(start);
    expect(at(2)).toBe(end);
    expect(end).not.toMatch(MODEL_NAMES);
  });

  it('is plain content without onPick, and clickable people and cards with it', () => {
    const plain = renderToStaticMarkup(createElement(JuryCanvasPlayer, { progress: 0.5, brief: true }));
    expect(plain).not.toContain('<button');
    const clickable = renderToStaticMarkup(createElement(JuryCanvasPlayer, { progress: 0.5, brief: true, onPick: () => {} }));
    expect(clickable.match(/<button/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
