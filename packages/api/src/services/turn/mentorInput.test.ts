/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { agentTurnBody } from '../../shared/agentTurn';
import { CHECKLIST_UPDATED_INPUT, OPENING_INPUT } from '../../shared/opcQuestions';
import { STEP_SUMMARY_INPUT } from '../../shared/opcStepSummary';
import { answeredText, confirmationAsked, mentorAnsweredCard, mentorReplyBody, mentorTurnInput, profileLinksDeclined, userHasSpoken } from './mentorInput';

const card = { question: 'Which one first?', options: ['Coffee', 'Tea'], recommended: 0 };
const item = (role: 'user' | 'assistant', content: string, seq: number) => ({ seq, role, content, contentHash: 'a'.repeat(64) });

describe('mentor turn kinds (V2-5b, the old path rules)', () => {
  it('opening, summary and checklist events, and what each may not carry', () => {
    expect(mentorTurnInput({ text: OPENING_INPUT, organizeAfter: false })).toEqual({ opening: true, summary: false, organize: true });
    expect(mentorTurnInput({ text: STEP_SUMMARY_INPUT, organizeAfter: false })).toEqual({ opening: false, summary: true, organize: false });
    expect(mentorTurnInput({ text: CHECKLIST_UPDATED_INPUT + '["goal"]', organizeAfter: true }))
      .toEqual({ opening: false, summary: false, updatedFieldIds: ['goal'], organize: true });
    expect(mentorTurnInput({ text: 'hello', organizeAfter: true })).toEqual({ opening: false, summary: false, organize: true });
    for (const bad of [{ text: STEP_SUMMARY_INPUT, organizeAfter: true }, { text: STEP_SUMMARY_INPUT, organizeAfter: false, answer: { sourceSeq: 2 } },
      { text: OPENING_INPUT, organizeAfter: false, answer: { sourceSeq: 2 } }, { text: CHECKLIST_UPDATED_INPUT + '["goal"]', organizeAfter: true, answer: { sourceSeq: 2 } },
      { text: CHECKLIST_UPDATED_INPUT + 'not json', organizeAfter: true }, { text: 'HOST_STEP_SUMMARY:v0', organizeAfter: false }])
      expect(() => mentorTurnInput(bad)).toThrow('TURN_REQUEST_INVALID');
  });

  it('an answer binds to the card of the latest mentor reply of this step; a chosen option becomes the words', () => {
    const reply = mentorReplyBody(agentTurnBody('', card as never), 'step-0', 'round-1');
    expect(JSON.parse(reply)).toMatchObject({ stepId: 'step-0', roundId: 'round-1' });
    const history = [item('user', 'Coffee or tea?', 1), item('assistant', reply, 2)];
    const answered = mentorAnsweredCard(history, 'step-0', { sourceSeq: 2, optionIndex: 1 }, 7);
    expect(answered).toMatchObject({ optionIndex: 1, card: { options: ['Coffee', 'Tea'] } });
    expect(answeredText('ignored', answered)).toBe('Tea');
    expect(answeredText('my own words', mentorAnsweredCard(history, 'step-0', { sourceSeq: 2 }, 7))).toBe('my own words');
    expect(() => mentorAnsweredCard(history, 'step-1', { sourceSeq: 2, optionIndex: 0 }, 7)).toThrow('TURN_ANSWER_SOURCE_DENIED');
    expect(() => mentorAnsweredCard(history, 'step-0', { sourceSeq: 2, optionIndex: 4 }, 7)).toThrow('TURN_ANSWER_SOURCE_DENIED');
    const later = [...history, item('user', 'x', 3), item('assistant', mentorReplyBody(agentTurnBody('prose', null), 'step-0', 'round-1'), 4)];
    expect(() => mentorAnsweredCard(later, 'step-0', { sourceSeq: 4 }, 7)).toThrow('TURN_ANSWER_SOURCE_DENIED');
    // A stale tab answers the card it saw after a newer card replaced it: refused, not mapped onto the newer card's options.
    const newer = [...history, item('user', 'x', 3), item('assistant', reply, 4)];
    expect(() => mentorAnsweredCard(newer, 'step-0', { sourceSeq: 2, optionIndex: 0 }, 7)).toThrow('TURN_ANSWER_SOURCE_DENIED');
    expect(mentorAnsweredCard(newer, 'step-0', { sourceSeq: 4, optionIndex: 0 }, 7)).toMatchObject({ optionIndex: 0 });
  });
});

// Owner 2026-11-27 pay2: seq 12, 14, 16 and 18 all asked the user to click the confirmation card. The coach's own words.
describe('confirmationAsked: an earlier reply of this step and round already asked for the confirmation card', () => {
  const reply = (seq: number, message: string, stepId = 'step-1', roundId = 'r1') =>
    ({ seq, role: 'assistant' as const, content: JSON.stringify({ format: 'agent-turn.v1', message, card: null, stepId, roundId }),
      contentHash: 'a'.repeat(64) });
  const seq12 = '请看一下这些内容有没有写错或漏掉的地方。没问题的话，请点击聊天里的确认卡片来确认这一步。确认之后我们再进入诊断和对标。';
  it('is true after the seq 12 reply in the same step and round', () => {
    expect(confirmationAsked([reply(10, '好的，没有对标账号也没关系。'), reply(12, seq12)], 'step-1', 'r1')).toBe(true);
    expect(confirmationAsked([reply(2, 'Please click the confirmation card in the chat to confirm this step.')], 'step-1', 'r1')).toBe(true);
  });
  it('is false before any request, for another step, another round, user words or an unreadable row', () => {
    expect(confirmationAsked([reply(10, '好的，没有对标账号也没关系。')], 'step-1', 'r1')).toBe(false);
    expect(confirmationAsked([reply(12, seq12, 'step-1')], 'step-2', 'r1')).toBe(false);
    expect(confirmationAsked([reply(12, seq12, 'step-1', 'r0')], 'step-1', 'r1')).toBe(false);
    expect(confirmationAsked([{ seq: 11, role: 'user', content: '确认卡在哪？', contentHash: 'a'.repeat(64) }], 'step-1', 'r1')).toBe(false);
    expect(confirmationAsked([{ seq: 12, role: 'assistant', content: '请点击确认卡片', contentHash: 'a'.repeat(64) }], 'step-1', 'r1')).toBe(false);
  });
});

describe('userHasSpoken: before it, an opening is the conversation\'s first and shows no card (MASTER_PLAN §3 item 1)', () => {
  const user = (seq: number, content: string) => ({ seq, role: 'user' as const, content, contentHash: 'a'.repeat(64) });
  it('host markers are not the user\'s words; a typed message or a card answer is', () => {
    expect(userHasSpoken([])).toBe(false);
    expect(userHasSpoken([user(1, OPENING_INPUT), item('assistant', '你做这个账号，最希望它最后给你带来什么？', 2)])).toBe(false);
    expect(userHasSpoken([user(1, STEP_SUMMARY_INPUT), user(3, CHECKLIST_UPDATED_INPUT)])).toBe(false);
    expect(userHasSpoken([user(1, OPENING_INPUT), user(3, '我想靠周末的手工皮具体验课接到付费学员。')])).toBe(true);
  });
});

// Owner 2026-11-27 pay2: the user's own words (seq 5 of the second run, seq 29 after the search, seq 9 of the first run).
describe('profileLinksDeclined: the user said they have or will send no profile links', () => {
  const link = (text: string) => text.includes('https://www.xiaohongshu.com/user/profile/');
  it('is true after the user declines, in either language', () => {
    expect(profileLinksDeclined(['我想在小红书做皮具手作体验课。', '没有对标账号，也没有主页链接，我也暂时不想找。'], link)).toBe(true);
    expect(profileLinksDeclined(['我前面说过没有主页链接，也不想去找账号；这次先不换词重搜。'], link)).toBe(true);
    expect(profileLinksDeclined(['我没想好要参考哪个账号，也没有主页链接。'], link)).toBe(true);
    expect(profileLinksDeclined(["I don't have any profile links."], link)).toBe(true);
  });
  it('is false without a decline, and a later message with a profile link reopens it', () => {
    expect(profileLinksDeclined(['可以先试“成都皮具体验课”这几个词。', '我做皮具差不多两年。'], link)).toBe(false);
    expect(profileLinksDeclined(['没有主页链接。', '找到了一个：https://www.xiaohongshu.com/user/profile/abc'], link)).toBe(false);
  });
});
