/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {readAgentTurnBody} from '../../../shared/agentTurn';
import {projectMentorHistory, organizerInstructions} from '../mentorPrompt';
import {agentTurnResult} from './agentTurnResult';
import {ORGANIZER_CARD_KEY, ORGANIZER_CARD_RULE, organizerNeutralCard, withOrganizerCard, withoutOrganizerCard} from './organizerCard';

// A fixed sample of the 2026-11-27 real-model run (a staging test account): the mentor asked how the service is charged,
// a neutral category question, in prose only; the model never called ask_question.
const reply = '好的，你目前没有特意想对标的账号，这没问题。\n\n' +
  '**你打算怎么给上门收纳服务定价和收费？比如你现在有没有大概的想法：按小时、按房间，还是按整套房子？**\n\n' +
  '你不确定也没关系，说说你目前的倾向，我再帮你分析。';
const question = '你打算怎么给上门收纳服务定价和收费？比如你现在有没有大概的想法：按小时、按房间，还是按整套房子？';
const output = (card: unknown) => ({inputKind: 'answer', patches: [], notes: [], [ORGANIZER_CARD_KEY]: card});

describe('a neutral question the mentor wrote as prose gets its card (Owner 2026-11-26, option A)', () => {
  it('the organizer names the question and its categories: a card with no recommendation under the same prose', () => {
    const card = organizerNeutralCard(output({question, options: ['按小时', '按房间', '按整套房子']}), reply);
    expect(card).toMatchObject({question, options: ['按小时', '按房间', '按整套房子'], recommended: null,
      recommendationReason: null, message: reply});
    const turn = withOrganizerCard(agentTurnResult(reply, reply, false), card!);
    // Saved, reloaded and read back as the next turn's history, the reply is the same prose and still carries the card.
    const read = readAgentTurnBody(turn.body);
    expect(read.message).toBe(reply);
    expect(read.card).toMatchObject({question, options: ['按小时', '按房间', '按整套房子'], recommended: null});
    expect(projectMentorHistory([{role: 'assistant', content: turn.body}] as never)[0]!.content).toBe(reply);
  });

  it('before: a prose-only reply has no card at all (what the user saw in every turn of the run)', () => {
    expect(agentTurnResult(reply, reply, false).card).toBeNull();
    expect(organizerNeutralCard({inputKind: 'answer', patches: [], notes: []}, reply)).toBeNull();
  });

  it('the question must be the mentor\'s own words; bold marks and spacing do not matter', () => {
    expect(organizerNeutralCard(output({question: '**' + question + '**', options: ['按小时', '按房间']}), reply)).not.toBeNull();
    expect(organizerNeutralCard(output({question: '你会按小时还是按次收费？', options: ['按小时', '按次']}), reply)).toBeNull();
    expect(organizerNeutralCard(output({question: '收费？', options: ['按小时', '按次']}), reply)).toBeNull();
  });

  it('options are 2 to 5 distinct short labels; anything else shows no card', () => {
    const card = (options: unknown) => organizerNeutralCard(output({question, options}), reply);
    expect(card(['按小时'])).toBeNull();
    expect(card(['a', 'b', 'c', 'd', 'e', 'f'])).toBeNull();
    expect(card(['按小时', '按小时'])).toBeNull();
    expect(card(['按小时', ''])).toBeNull();
    expect(card(['按小时', '按房间收费，适合只整理厨房或衣柜这类单个空间的客户'])).toBeNull();
    expect(card(['按小时', 3])).toBeNull();
    expect(organizerNeutralCard(output(null), reply)).toBeNull();
    expect(organizerNeutralCard(null, reply)).toBeNull();
  });

  it('the card never reaches turn_close: the checklist output keeps only its own keys', () => {
    expect(withoutOrganizerCard(output({question, options: ['按小时', '按房间']}))).toEqual({inputKind: 'answer', patches: [], notes: []});
    expect(withoutOrganizerCard('not json')).toBe('not json');
    expect(withoutOrganizerCard(null)).toBeNull();
  });

  it('the organizer is asked for a card only on a turn that may carry one, never on an opening', () => {
    expect(organizerInstructions(undefined, false, true)).toContain(ORGANIZER_CARD_RULE);
    expect(organizerInstructions(undefined, false)).not.toContain(ORGANIZER_CARD_KEY);
    expect(organizerInstructions(undefined, true, true)).not.toContain(ORGANIZER_CARD_KEY);
    // Personal questions and guesses about the user stay prose.
    expect(ORGANIZER_CARD_RULE).toMatch(/experience, strengths, story/);
    expect(ORGANIZER_CARD_RULE).toMatch(/guesses about this user/);
  });
});
