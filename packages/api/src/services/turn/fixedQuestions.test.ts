/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { agentTurnBody } from '../../shared/agentTurn';
import { captureHostContext, type CaptureState } from '../opc/captureContext';
import { FIXED_QUESTIONS, fixedCardChoice, fixedQuestionCard, fixedQuestionFor, laterFixedQuestions, organizerWrote } from './fixedQuestions';
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
  fixedQuestionFor({ host: h, history: [], roundId: 'r1', locale: 'zh-Hans', firstOpening: false, summary: false, mode: 'mentor', words: '我在杭州教周末皮具手作。', ...extra });
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
    // The user asks for no questions or options in this turn (review of #2060): that request wins, the field waits.
    for (const words of ['先不要提问或给选项，只回答我的问题。', '别再问我了，直接说结论', 'Please, no more questions, just answer.'])
      expect(pick(host('step-1'), { words })).toBeNull();
    expect(pick(host('step-1'), { words: '我想先问问，小红书适合我吗？' })?.fixed.id).toBe('goal');
    expect(pick(host('step-1'), { words: '我只讲皮具，不讲别的。' })?.fixed.id).toBe('goal');
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
    // The card was under an earlier reply (the latest one, after the user answered something else, has none).
    const history = [reply(4, agentTurnBody('好的。', timeCard)), reply(6, agentTurnBody('先说你的问题。', null))];
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
  // pay2 2026-11-27 (seq 9-12, summarised): the user had given the goal, the customers and what they already run; this turn
  // answers the content direction (track), so the host's next field was track (personal, no card) and the coach went on to ask
  // the platform in prose with examples. The host now hands the coach the later list questions and shows the card it asks.
  it('a later list field the coach gets to in this turn gets its card when the coach asks its question exactly', () => {
    const atSeq9 = host('step-1', { goal: '给生意带客户', audience: '附近喜欢 DIY 的年轻女性', assets: '杭州周末皮具手作体验课' });
    const words = '我会拍手工制作过程和最终成品，也想记录学员亲手做出卡包的体验过程。先做图文和短视频都可以。';
    expect(pick(atSeq9, { words })).toBeNull();
    const later = laterFixedQuestions({ host: atSeq9, history: [], roundId: 'r1', locale: 'zh-Hans', firstOpening: false, summary: false,
      mode: 'mentor', words });
    expect(later.map(q => q.fixed.id)).toEqual(['platform', 'weekly_time']);
    const wrote = (ids: string[]) => (fieldId: string) => ids.includes(fieldId);
    const reply = '这些内容很贴合你的目标。接下来想了解平台。\n\n**你打算先在哪个平台做？**';
    expect(fixedCardChoice({ chosen: null, later, reply, written: wrote(['track']) })?.fixed.id).toBe('platform');
    // The reply of the real run asked in its own words: no card (exact text only, no fuzzy matching).
    expect(fixedCardChoice({ chosen: null, later, reply: '**你有没有特别想做的平台？或者你自己平时最常刷哪个？**', written: wrote(['track']) }))
      .toBeNull();
    // The user answered the platform in passing (the organizer wrote it): no card even when the question is quoted.
    expect(fixedCardChoice({ chosen: null, later, reply, written: wrote(['track', 'platforms']) })).toBeNull();
    // Seq 11-12: the host's question (platform) was answered in this turn and the coach went on to the time question.
    const atSeq11 = host('step-1', { ...before('platforms'), assets: '体验课' });
    const chosen = pick(atSeq11, { words: '我想先从小红书开始。' });
    const later11 = laterFixedQuestions({ host: atSeq11, history: [], roundId: 'r1', locale: 'zh-Hans', firstOpening: false,
      summary: false, mode: 'mentor', words: '我想先从小红书开始。' });
    expect(chosen?.fixed.id).toBe('platform');
    expect(later11.map(q => q.fixed.id)).toEqual(['weekly_time']);
    expect(fixedCardChoice({ chosen, later: later11, reply: '记下了。**你每周大概能拿出多少时间做账号？**', written: wrote(['platforms']) })
      ?.fixed.id).toBe('weekly_time');
    // Without a quoted question the host's own question keeps its card, unless the user answered it.
    expect(fixedCardChoice({ chosen, later: later11, reply: '好的。', written: wrote([]) })?.fixed.id).toBe('platform');
    expect(fixedCardChoice({ chosen, later: later11, reply: '好的。', written: wrote(['platforms']) })).toBeNull();
    // The rules that give no question give no later questions either.
    expect(laterFixedQuestions({ host: atSeq9, history: [], roundId: 'r1', locale: 'zh-Hans', firstOpening: true, summary: false,
      mode: 'mentor', words: '' })).toEqual([]);
  });
  // pay4 2026-11-27 (seq 12-14, the real words): the time card was under seq 12; seq 13 answered time, filming and budget at
  // once; the host, before the organizer wrote resources, handed the coach the filming question, and seq 14 asked it with no card.
  it('the field whose card the user is answering this turn is not asked about again in it', () => {
    const atSeq13 = host('step-1', { goal: '给生意带客户', track: '手工制作过程和成品', audience: '附近喜欢 DIY 的年轻女性',
      platforms: '小红书', assets: '杭州周末皮具手作体验课' });
    const time = FIXED_QUESTIONS.find(q => q.id === 'weekly_time')!;
    const timeCard = fixedQuestionCard({ fixed: time, question: time.question['zh-Hans'], options: time.options['zh-Hans'] },
      '选小红书，我记下了。接下来要排内容节奏，所以想问你这一项：\n\n你每周大概能拿出多少时间做账号？');
    const history = [reply(12, agentTurnBody('选小红书，我记下了。接下来要排内容节奏，所以想问你这一项：\n\n你每周大概能拿出多少时间做账号？', timeCard))];
    const at = (words: string) => ({ host: atSeq13, history, roundId: 'r1', locale: 'zh-Hans' as const, firstOpening: false,
      summary: false, mode: 'mentor', words });
    const words = '每周大概四小时，不露脸，不投广告。';
    expect(fixedQuestionFor(at(words))).toBeNull();
    expect(laterFixedQuestions(at(words))).toEqual([]);
    const seq14 = '每周大概四小时，不露脸，不投广告，这三点我都记下了。\n\n接下来还差一项资源信息，我想弄清你拍内容时的实际条件：\n\n拍内容时，你能接受哪种方式？';
    expect(fixedCardChoice({ chosen: null, later: laterFixedQuestions(at(words)), reply: seq14, written: f => f === 'resources' })).toBeNull();
    // An option clicked on the card is an answer too.
    expect(laterFixedQuestions(at('3 到 6 小时'))).toEqual([]);
    // When the organizer did not write the field (the user answered something else), the next turn asks its next question.
    const after = [...history, { seq: 13, role: 'user' as const, content: '我想先问问别的。', contentHash: 'b'.repeat(64) },
      reply(14, agentTurnBody('好的，先说你的问题。', null))];
    expect(laterFixedQuestions({ ...at('再说说吧。'), history: after }).map(q => q.fixed.id)).toEqual(['filming']);
    // A turn without the user's words (a later step's opening, a refresh of the current question) is not an answer.
    expect(laterFixedQuestions(at('')).map(q => q.fixed.id)).toEqual(['filming']);
  });
});
