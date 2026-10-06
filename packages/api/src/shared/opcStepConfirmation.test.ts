/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect, it} from 'vitest';
import {stepConfirmation, withStepConfirmation} from './opcStepConfirmation';
const schema = [{id: 'fact', required: true}, {id: 'defer', required: true}, {id: 'optional', required: false}];
const values = {fact: {value: 'Recorded fact', status: 'provisional'}, defer: {value: 'Decide after pilot', status: 'deferred'}};
it('separates completeness from confirmation, including deferral reasons and optional fields', () => {
  expect(stepConfirmation({schema, values}, false)).toEqual({requiredComplete: true, stepConfirmed: false,
    stepReady: true, needsLookFieldIds: ['fact']});
  expect(stepConfirmation({schema, values}, true)).toEqual({requiredComplete: true, stepConfirmed: true,
    stepReady: false, needsLookFieldIds: []});
  expect(stepConfirmation({schema, values: {...values, defer: {value: '  ', status: 'deferred'}}}, false).stepReady).toBe(false);
  expect(stepConfirmation({schema, values: {...values, fact: {value: '', status: 'confirmed'}}}, false).requiredComplete).toBe(false);
  expect(stepConfirmation({schema: []}, false).stepReady).toBe(false);
  expect(stepConfirmation(undefined, false).stepReady).toBe(false);
});
it('marks non-manual provisional values and proposals without adopting pending suggestions', () => {
  const ids = ['manual', 'capture', 'proposal', 'legacy', 'confirmed', 'deferred', 'empty', 'unclear', 'suggestion'];
  const state = {schema: ids.map(id => ({id})), values: Object.fromEntries(ids.map(id => [id,
    {value: id === 'empty' ? '' : id, status: ['confirmed', 'deferred', 'unclear'].includes(id) ? id : 'provisional'}])),
    meta: {manual: {source: 'user', basis: 'agent_proposal'}, capture: {source: 'capture', basis: 'user_statement'},
      proposal: {source: 'capture', basis: 'agent_proposal'}, suggestion: {source: 'user'}}};
  expect(stepConfirmation(state, false).needsLookFieldIds).toEqual(['capture', 'proposal', 'legacy']);
  state.values.proposal!.status = 'unclear';
  expect(stepConfirmation(state, false).needsLookFieldIds).toContain('proposal');
});
it('field statuses never confirm a step and missing legacy provenance is conservatively reviewable', () => {
  expect(stepConfirmation({schema, values: {...values, fact: {value: 'Fact', status: 'confirmed'}}}, false))
    .toMatchObject({stepReady: true, stepConfirmed: false, needsLookFieldIds: []});
  expect(stepConfirmation({schema, values}, false).needsLookFieldIds).toEqual(['fact']);
});
it('read projection uses each step validity and leaves stored data untouched', () => {
  const draft = {roundId: 'round', snapshot: {steps: {first: {valid: false}, later: {valid: true}}},
    information: {first: {schema, values}, later: {schema, values}}};
  const before = JSON.stringify(draft);
  expect(withStepConfirmation(draft)).toMatchObject({roundId: 'round', stepConfirmation: {
    first: {stepReady: true, stepConfirmed: false}, later: {stepReady: false, stepConfirmed: true},
  }});
  expect(JSON.stringify(draft)).toBe(before);
});
