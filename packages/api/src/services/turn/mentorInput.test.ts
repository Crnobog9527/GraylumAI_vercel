/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { agentTurnBody } from '../../shared/agentTurn';
import { CHECKLIST_UPDATED_INPUT, OPENING_INPUT } from '../../shared/opcQuestions';
import { STEP_SUMMARY_INPUT } from '../../shared/opcStepSummary';
import { answeredText, mentorAnsweredCard, mentorReplyBody, mentorTurnInput } from './mentorInput';

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
