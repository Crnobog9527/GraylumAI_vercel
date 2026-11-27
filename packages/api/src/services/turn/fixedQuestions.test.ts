/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { agentTurnBody } from '../../shared/agentTurn';
import { captureHostContext, type CaptureState } from '../opc/captureContext';
import { FIXED_QUESTIONS, fixedQuestionCard, fixedQuestionFor, organizerWrote } from './fixedQuestions';
import { mentorReplyBody } from './mentorInput';
import type { HistoryItem } from './db';

// The positioning Skill's first two steps (workflow.yaml of the pinned revision): field ids, required, roles, in order.
const STEP1 = ['goal', 'track', 'audience', 'platforms', 'benchmarks', 'resources', 'assets'];
const STEP2 = ['feasibility', 'platform_choice', 'benchmark_findings'];
const steps = [{ id: 'step-1', title: '了解你' }, { id: 'step-2', title: '诊断与平台对标' }];
const state = (ids: string[], role: 'user_fact' | 'agent_proposal', filled: Record<string, string>): CaptureState => ({
  schema: ids.map(id => ({ id, title: id, required: true, elicitation: role })),
  values: Object.fromEntries(Object.entries(filled).map(([id, value]) => [id, { value, status: 'provisional' }])),
});
const host = (stepId: string, filled: Record<string, string> = {}, opts: { opening?: boolean; confirmed?: boolean } = {}) =>
  captureHostContext(steps, { 'step-1': state(STEP1, 'user_fact', stepId === 'step-1' ? filled : Object.fromEntries(STEP1.map(id => [id, 'x']))),
    'step-2': state(STEP2, 'agent_proposal', stepId === 'step-2' ? filled : {}) }, stepId, opts.opening ?? false, undefined,
  { 'step-1': stepId === 'step-2' || Boolean(opts.confirmed) });
const reply = (seq: number, body: string, roundId = 'r1'): HistoryItem =>
  ({ seq, role: 'assistant', content: mentorReplyBody(body, 'step-1', roundId), contentHash: 'a'.repeat(64) });
const pick = (h: ReturnType<typeof host>, extra: Partial<Parameters<typeof fixedQuestionFor>[0]> = {}) =>
  fixedQuestionFor({ host: h, history: [], roundId: 'r1', locale: 'zh-Hans', firstOpening: false, summary: false, mode: 'mentor', ...extra });
const before = (upTo: string) => Object.fromEntries(STEP1.slice(0, STEP1.indexOf(upTo)).map(id => [id, '已说过']));

describe('Owner 2026-11-27 option C: which fixed question the host asks, and when none', () => {
  it('asks the list question when the next empty field of the step is its field, in the reply language', () => {
    expect(pick(host('step-1'))?.fixed.id).toBe('goal');
    expect(pick(host('step-1', before('platforms')))).toMatchObject({ question: '你打算先在哪个平台做？', options: ['小红书', '抖音', '视频号', 'B站'] });
    expect(pick(host('step-1', before('resources')), { locale: 'en' })?.question).toBe('How much time can you give the account each week?');
    expect(pick(host('step-1', before('resources')), { locale: 'zh-Hant' })?.question).toBe('你每週大概能拿出多少時間做帳號？');
  });
  it('a personal field next (track, audience, benchmarks, assets) gets no card, even with a list field empty after it', () => {
    for (const field of ['track', 'audience', 'benchmarks', 'assets']) expect(pick(host('step-1', before(field)))).toBeNull();
  });
  it('the first opening, a step summary, a ready or confirmed step get no card', () => {
    expect(pick(host('step-1', {}, { opening: true }), { firstOpening: true })).toBeNull();
    expect(pick(host('step-1'), { summary: true })).toBeNull();
    // Importing an existing positioning asks for the user's material, not the interview's questions.
    expect(pick(host('step-1'), { mode: 'manual' })).toBeNull();
    const ready = Object.fromEntries(STEP1.map(id => [id, '已说过']));
    expect(pick(host('step-1', ready))).toBeNull();
    expect(pick(host('step-1', {}, { confirmed: true }))).toBeNull();
    // A later step's opening is not the first: its question is asked.
    expect(pick(host('step-2', {}, { opening: true }))?.fixed.id).toBe('benchmark_kind');
  });
  it('an answered field gets no card; a question already shown in the round is not asked again (the next one of its field is)', () => {
    expect(pick(host('step-1', { ...before('resources'), resources: '每周四小时' }))).toBeNull();
    const timeCard = fixedQuestionCard(pick(host('step-1', before('resources')))!, '好的。');
    const history = [reply(4, agentTurnBody('好的。', timeCard))];
    expect(pick(host('step-1', before('resources')), { history })?.fixed.id).toBe('filming');
    expect(pick(host('step-1', before('resources')), { history, roundId: 'r2' })?.fixed.id).toBe('weekly_time');
    const all = FIXED_QUESTIONS.filter(q => q.fieldId === 'resources')
      .map((q, i) => reply(10 + i, agentTurnBody('好的。', fixedQuestionCard({ fixed: q, question: q.question['zh-Hans'], options: q.options['zh-Hans'] }, '好的。'))));
    expect(pick(host('step-1', before('resources')), { history: all })).toBeNull();
  });
  it('step 2 asks which kind of account only before its search starts', () => {
    expect(pick(host('step-2'))?.question).toBe('你想先参考哪一类账号？');
    expect(pick(host('step-2', { benchmark_findings: '本次未取到数据' }))).toBeNull();
    const searching = { ...host('step-2'), research: { note: 'n', cards: [{ kind: 'keywords' as const, cardId: '10000000-0000-4000-8000-000000000001',
      confirmationId: null, keywords: ['皮具体验课'] }], benchmarks: { required: 3, qualified: 0, rows: [] } } } as unknown as ReturnType<typeof host>;
    expect(pick(searching)).toBeNull();
  });
  it('every card has 2 to 5 short options, no recommendation, in all three languages', () => {
    for (const q of FIXED_QUESTIONS) for (const locale of ['zh-Hans', 'zh-Hant', 'en'] as const) {
      const card = fixedQuestionCard({ fixed: q, question: q.question[locale], options: q.options[locale] }, '说明');
      expect(card.recommended).toBeNull();
      expect(card.options.length).toBeGreaterThanOrEqual(2);
      expect(card.options.length).toBeLessThanOrEqual(5);
      for (const option of card.options) expect(option.length).toBeLessThanOrEqual(locale === 'en' ? 30 : 10);
    }
  });
  it('the user answered the field in passing when the organizer wrote it this turn', () => {
    const out = { inputKind: 'answer', patches: [{ stepId: 'step-1', fieldId: 'resources', value: '每周四小时' }], notes: [] };
    expect(organizerWrote(out, 'step-1', 'resources')).toBe(true);
    expect(organizerWrote(out, 'step-1', 'platforms')).toBe(false);
    expect(organizerWrote(null, 'step-1', 'resources')).toBe(false);
  });
});
