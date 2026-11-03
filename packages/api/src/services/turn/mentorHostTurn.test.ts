/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { CHECKLIST_UPDATED_INPUT } from '../../shared/opcQuestions';
import { captureWorkflowSteps as workflow } from '../__tests__/fixtures/captureWorkflow';
import { mentorHost, mentorOrganizerInput, mentorState } from './mentorContext';
import { answeredText } from './mentorInput';
import { mentorSystem } from './mentorPrompt';
import { organizerInstructions } from './mentorPrompt';

// The host state a mentor turn is built from, now on the turn path (turn_mentor_context): the confirmation gate, the step summary
// and the checklist event keep the rules the old prepareStep admission tests (captureAdmission.test.ts) held.
const id = '10000000-0000-4000-8000-000000000001';
const field = (fieldId: string) => ({ id: fieldId, title: fieldId, required: true });
const raw = (step: Record<string, unknown>) => ({
  draftId: id, projectId: id, roundId: id, mode: 'new', moduleId: id, skillId: id, revisionId: id, packageHash: 'a'.repeat(64),
  steps: [{ id: 'first', title: 'First', information: [field('goal'), field('audience')], resources: ['SKILL.md'] }],
  suggestions: {}, fallbackEligible: false, work: { roundId: id, steps: { first: { version: 1, ...step } } } });
const complete = { valid: false, information: { goal: { value: 'Recorded goal', status: 'provisional' }, audience: { value: 'Pilot first', status: 'deferred' } },
  fieldMeta: { goal: { source: 'capture', basis: 'user_statement' } } };
const turn = { opening: false, summary: false };
const system = (host: ReturnType<typeof mentorHost>, summary = false) => mentorSystem({ skillText: 'skill', skillEntryChars: 0,
  brandIdentity: false, mode: 'new', host, skillFile: false, replyRule: '', summary }).instructions;

describe('mentor host turn (confirmation gate, summary, checklist event)', () => {
  it.each(['继续', '下一步', '没问题', '好的', '确认了，进入下一步', '好的，后续我想每周发三次'])(
    'a complete but unconfirmed step stays behind the confirmation gate for %s', input => {
      const state = mentorState(raw(complete), 'first');
      const host = mentorHost(state, 'first', turn);
      expect(host.confirmation).toEqual({ requiredComplete: true, stepConfirmed: false, stepReady: true, needsLookFieldIds: ['goal'] });
      const instructions = system(host);
      expect(instructions).toContain('Do not start the next step');
      expect(instructions).toContain('any verbal assent are not confirmation');
      expect(mentorOrganizerInput(state, host, input).value).toMatchObject({ userInput: input });
      expect(organizerInstructions(undefined, false)).toContain('including later steps');
    });

  it('the frozen step validity decides whether the step is confirmed, not an earlier snapshot', () => {
    const state = mentorState(raw({ valid: true, information: { goal: { value: 'A', status: 'confirmed' }, audience: { value: 'B', status: 'confirmed' } } }), 'first');
    expect(mentorHost(state, 'first', turn).confirmation).toMatchObject({ stepConfirmed: true, stepReady: false });
  });

  it('a step summary freezes the missing fields and keeps the confirmation state, with no organizer instructions', () => {
    const state = mentorState(raw({ valid: false, information: {} }), 'first');
    const host = mentorHost(state, 'first', { opening: false, summary: true });
    expect(host).toMatchObject({ stepSummary: { kind: 'step_summary', missingRequiredFieldIds: ['goal', 'audience'] },
      confirmation: { requiredComplete: false, stepConfirmed: false } });
    const instructions = system(host, true);
    expect(instructions).toContain('write the step summary now');
    expect(instructions.length).toBeLessThanOrEqual(8000);
  });

  it('a checklist event is the host\'s words, not the user\'s: the organizer sees the event and no user speech', () => {
    const state = mentorState(raw(complete), 'first');
    const host = mentorHost(state, 'first', { opening: false, summary: false, updatedFieldIds: ['goal'] });
    const input = CHECKLIST_UPDATED_INPUT + '["goal"]';
    expect(mentorOrganizerInput(state, host, input).value)
      .toMatchObject({ userInput: '', hostEvent: { kind: 'checklist_updated', fieldIds: ['goal'] } });
    expect(system(host)).not.toContain(input);
  });

  it('an answered card hands the organizer the chosen option and becomes the user\'s words', () => {
    const state = mentorState(raw(complete), 'first');
    const host = mentorHost(state, 'first', turn);
    const answered = { executionId: '7', card: { question: 'Platform?', options: ['A', 'B'], recommended: null }, optionIndex: 1 };
    expect(answeredText('ignored', answered)).toBe('B');
    expect(mentorOrganizerInput(state, host, 'B', answered).value).toMatchObject({ answeredCard: { selectedOption: 'B' } });
  });
});

// The real six-step method at its last step (agentTurnPromptCapacity.test.ts held this on the old admission): the host state fits
// its byte limit whatever the last step's field statuses, and the organizer's input stays inside its own.
describe.each([false, true])('the real six-step method at its last step (opening %s)', opening => {
  it.each(['missing', 'provisional', 'confirmed', 'deferred'])('fits the host and organizer limits when the last step is %s', status => {
    const work = Object.fromEntries(workflow.map((step, index) => [step.id, { version: 1, valid: index < 5,
      information: Object.fromEntries(step.information.flatMap(item => index === 5 && status === 'missing' ? []
        : [[item.id, { status: index === 5 ? status : 'confirmed', value: 'Synthetic confirmed material', nature: 'decision' }]])) }]));
    const state = mentorState({ ...raw({}), steps: workflow.map(step => ({ id: step.id, title: step.title, information: step.information,
      resources: ['SKILL.md'] })), work: { roundId: id, steps: work } }, 'step-6');
    const host = mentorHost(state, 'step-6', { opening, summary: false });
    expect(host.checklist).toHaveLength(6);
    expect(host.opening).toBe(opening);
    expect(Buffer.byteLength(JSON.stringify(host))).toBeLessThanOrEqual(16000);
    expect(mentorOrganizerInput(state, host, opening ? 'x' : '我不确定，帮我分析').text.length).toBeLessThanOrEqual(24000);
  });
});
