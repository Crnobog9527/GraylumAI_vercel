import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/jury/page';
import {
  ADOPT_ERROR_LABEL, choosable, isComplete, linkedGroup, mockConfirm, mockPropose, needsConfirm, setConfirmed, setUse, toChoices, type ChoiceState,
} from './jury-adopt';
import {
  DEFAULT_SEAT_NAMES, resolveSeatNames, SAMPLE_PANEL, SEAT_NAME_MAX, summarize, type JuryEvent,
} from './jury-events';
import { posesAt } from './jury-poses';
import { failedSeatsAt } from './jury-progress';
import { buildScenes, playbackLength, sceneAt, skippedStages, stageIndex } from './jury-scenes';
import { findScenario, JURY_SCENARIOS } from './jury-scripts';
import { JuryResults } from './JuryResults';
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
    expect(posesAt(sceneAt(scenes, 10_000), 10_000, []).seats.A).toMatch(/reading|thinking/);
    expect(posesAt(sceneAt(scenes, 22_500), 22_500, []).seats.A).toBe('submitted');
    const failedScenes = buildScenes(findScenario('failed').arrivals);
    const end = playbackLength(failedScenes);
    expect(failedSeatsAt(failedScenes, end)).toEqual(['B']);
    expect(failedScenes.some(scene => scene.kind === 'failed' && scene.failure.reviewer === 'B')).toBe(true);
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

  it('shows the final opinion, reason and fix of each chapter, with a revised/original choice per changed chapter', () => {
    const { detail } = findScenario('full');
    const html = renderToStaticMarkup(createElement(JuryResults, { detail, names: DEFAULT_SEAT_NAMES, onOpenRecord: () => {} }));
    for (const section of choosable(detail.summary.sections)) expect(html).toContain(section.section);
    expect(html.match(/采用修订版/g)?.length).toBe(choosable(detail.summary.sections).length);
    expect(html).toContain('建议怎么改');
    const failedDetail = findScenario('failed').detail;
    const failed = renderToStaticMarkup(createElement(JuryResults, { detail: failedDetail, names: DEFAULT_SEAT_NAMES, onOpenRecord: () => {} }));
    expect(failed).toContain('修订稿没有生成成功');
    expect(failed).not.toContain('采用修订版');
  });
});
