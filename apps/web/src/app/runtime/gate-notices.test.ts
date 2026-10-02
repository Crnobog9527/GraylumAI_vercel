/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { runtimeGateMessages } from '../../../../../packages/api/src/shared/runtimeGateMessages';
import { OUTPUT_TRUNCATED_NOTICE, runtimeAdmissionNotice, runtimeExecutionNotice, videoGateError, videoGateNotice } from './gate-notices';

const prepareRefusal = (code: string, message: string) =>
  Object.assign(new Error(message), { data: { code, path: 'runtime.prepare', retryAfter: 60 } });

it.each([
  ['TOO_MANY_REQUESTS', runtimeGateMessages.minute],
  ['TOO_MANY_REQUESTS', runtimeGateMessages.day],
  ['SERVICE_UNAVAILABLE', runtimeGateMessages.paused],
  ['SERVICE_UNAVAILABLE', runtimeGateMessages.limit_unavailable],
])('send, writing and video admission refusals (%s) use the fixed notice', (code, message) => {
  expect(runtimeAdmissionNotice(prepareRefusal(code, message))).toBe(message);
});

it('does not treat execute failures or other 503 text as a gate refusal', () => {
  expect(runtimeAdmissionNotice(Object.assign(new Error(runtimeGateMessages.paused),
    { data: { code: 'SERVICE_UNAVAILABLE', path: 'runtime.execute' } }))).toBeNull();
  expect(runtimeAdmissionNotice(prepareRefusal('SERVICE_UNAVAILABLE', '计费配置暂不可用，新的收费已暂停，请稍后重试。'))).toBeNull();
});

it.each([
  ['call_limited', runtimeGateMessages.minute],
  ['paused', runtimeGateMessages.paused],
  ['limit_unavailable', runtimeGateMessages.limit_unavailable],
])('execute result %s maps to its notice and to a definite video refusal', (unavailable, notice) => {
  const result = { state: 'cancelled', unavailable };
  expect(runtimeExecutionNotice(result)).toBe(notice);
  const error = videoGateError(result);
  expect(error).toBeInstanceOf(Error);
  expect(videoGateNotice(error!.message)).toBe(notice);
});

it('keeps output truncation and leaves capacity and success to the page', () => {
  expect(runtimeExecutionNotice({ state: 'completed', unavailable: 'output_truncated' })).toBe(OUTPUT_TRUNCATED_NOTICE);
  expect(runtimeExecutionNotice({ state: 'cancelled', unavailable: 'capacity' })).toBeNull();
  expect(runtimeExecutionNotice({ state: 'completed' })).toBeNull();
  expect(videoGateError({ state: 'cancelled', unavailable: 'capacity' })).toBeNull();
  expect(videoGateNotice('OPC_CONTENT_DENIED')).toBeNull();
  expect(videoGateNotice('OPC_CONTENT_GATE_other')).toBeNull();
});
