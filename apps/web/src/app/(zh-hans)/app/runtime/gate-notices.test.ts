/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { DEFINITE_REFUSAL_NOTICE, definiteRefusal, definiteRefusalNotice, showsReply } from './gate-notices';
import { RUNTIME_INPUT_TOO_LONG_MESSAGE } from '../../../../../../../packages/api/src/shared/runtimeInputMessages';
import { RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE } from '../../../../../../../packages/api/src/shared/runtimeAdmissionMessages';

// What stays here is shared with the positioning pages (showsReply, definiteRefusal*); the notices of the old execution path are gone.

it('shows no "verifying" reply for a cancelled round without a body, and keeps every other reply', () => {
  expect(showsReply({ state: 'cancelled', body: null, primaryBody: null })).toBe(false);
  expect(showsReply({ state: 'cancelled', body: null, primaryBody: '已保存的主回复' })).toBe(true);
  // In progress: the streamed text and the turn's own notice show instead of a "verifying" placeholder.
  expect(showsReply({ state: 'running', body: null, primaryBody: null })).toBe(false);
  expect(showsReply({ state: 'interrupted', body: null, primaryBody: '已保存的主回复' })).toBe(true);
  expect(showsReply({ state: 'completed', body: '回复', primaryBody: null })).toBe(true);
});

const structured = (httpStatus: number, code: string, path = 'opc.topicTurn') =>
  Object.assign(new Error('fixed refusal'), { data: { httpStatus, code, path } });

it.each([
  [412, 'PRECONDITION_FAILED'], [403, 'FORBIDDEN'], [409, 'CONFLICT'], [400, 'BAD_REQUEST'], [404, 'NOT_FOUND'],
])('treats a structured %i %s as a definite refusal', (status, code) => {
  expect(definiteRefusal(structured(status, code))).toEqual({ path: 'opc.topicTurn' });
  expect(definiteRefusal(structured(status, code, 'opc.prepareVideoMaterial'))).toEqual({ path: 'opc.prepareVideoMaterial' });
});

it('leaves every uncertain or retryable failure open', () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [408, 'TIMEOUT'], [429, 'TOO_MANY_REQUESTS'],
    [503, 'SERVICE_UNAVAILABLE'], [500, 'INTERNAL_SERVER_ERROR']] as const)
    expect(definiteRefusal(structured(status, code))).toBeNull();
  expect(definiteRefusal(new Error('network'))).toBeNull();
  expect(definiteRefusal(Object.assign(new Error('x'), { data: { code: 'PRECONDITION_FAILED' } }))).toBeNull();
  expect(definiteRefusal('PRECONDITION_FAILED')).toBeNull();
});

it('names a definite refusal of the given procedures only with shared fixed texts', () => {
  const payg = Object.assign(new Error(RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE),
    { data: { httpStatus: 412, code: 'PRECONDITION_FAILED', path: 'opc.topicTurn' } });
  expect(definiteRefusalNotice(payg, ['opc.topicTurn'])).toBe(RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE);
  expect(definiteRefusalNotice(structured(412, 'PRECONDITION_FAILED'), ['opc.topicTurn'])).toBe(DEFINITE_REFUSAL_NOTICE);
  expect(definiteRefusalNotice(structured(412, 'PRECONDITION_FAILED'), ['opc.other'])).toBeNull();
  expect(definiteRefusalNotice(structured(503, 'SERVICE_UNAVAILABLE'), ['opc.topicTurn'])).toBeNull();
});

it('a paused round shows no reply until a body is saved', () => {
  expect(showsReply({ state: 'waiting_credits', body: null, primaryBody: null })).toBe(false);
  expect(showsReply({ state: 'waiting_credits', body: null, primaryBody: '主回复' })).toBe(true);
});
it('also names a too-long input refusal with its fixed text', () => {
  const tooLong = Object.assign(new Error(RUNTIME_INPUT_TOO_LONG_MESSAGE), { data: { httpStatus: 412, code: 'PRECONDITION_FAILED', path: 'opc.topicTurn' } });
  expect(definiteRefusalNotice(tooLong, ['opc.topicTurn'])).toBe(RUNTIME_INPUT_TOO_LONG_MESSAGE);
});
