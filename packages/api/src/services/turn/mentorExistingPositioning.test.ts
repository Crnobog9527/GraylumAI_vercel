/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { agentTurnInstructions } from '../opc/agentTurnPrompt';
import { mentorHost, mentorState } from './mentorContext';
import { mentorSystem, organizerInstructions } from './mentorPrompt';

// The opening of a step whose positioning the user already has (manual mode), on the turn path. These held on the old prepareStep
// admission (existingPositioningAdmission.test.ts); the instructions are built by mentorSystem from the same host state.
const id = '10000000-0000-4000-8000-000000000001';
const normalOpening = "Open this step's discussion naturally from known material";
const intake = 'ask the user to paste or describe their existing positioning';

function opening(mode: 'manual' | 'mentor', saved = false) {
  const values = saved ? { goal: { value: 'Existing material', status: 'provisional' } } : {};
  const state = mentorState({ draftId: id, projectId: id, roundId: id, mode, moduleId: id, skillId: id, revisionId: id,
    packageHash: 'a'.repeat(64), suggestions: {}, fallbackEligible: false,
    steps: [{ id: 'first', title: '了解你', information: [{ id: 'goal', title: 'Goal', required: true }], resources: ['SKILL.md'] },
      { id: 'later', title: 'Later', information: [{ id: 'goal', title: 'Goal', required: true }], resources: ['SKILL.md'] }],
    work: { roundId: id, steps: { first: { version: 1, valid: false, information: values }, later: { version: 1, valid: false, information: {} } } } }, 'first');
  const host = mentorHost(state, 'first', { opening: true, summary: false });
  return { host, instructions: mentorSystem({ skillText: '', skillEntryChars: 0, brandIdentity: false, mode, host, skillFile: false,
    replyRule: '' }).instructions };
}

it('freezes only import intake for a new manual opening, without a competing interview opening', () => {
  const { host, instructions } = opening('manual');
  expect(host).toMatchObject({ opening: true, stepId: 'first', confirmation: { stepReady: false, stepConfirmed: false } });
  expect(instructions).toContain(intake);
  expect(instructions).not.toContain(normalOpening);
  expect(instructions).toContain('Never treat supplied positioning or verbal assent as confirmation');
  expect(organizerInstructions(undefined, true)).toContain('Never confirm or defer a field');
  // Preserve the existing explicit-purpose-budget requirement, also exercised by the SQL integration.
  expect(instructions.length).toBeGreaterThan(8000);
});

it('keeps the normal mentor opening unchanged', () => {
  const { instructions } = opening('mentor');
  expect(instructions).toContain(agentTurnInstructions());
  expect(instructions).toContain(normalOpening);
  expect(instructions).not.toContain(intake);
});

it('reviews already recorded manual material without restarting import intake', () => {
  const { instructions } = opening('manual', true);
  expect(instructions).toContain('review the supplied positioning');
  expect(instructions).not.toContain(intake);
  expect(instructions).toContain(normalOpening);
});
