/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { runtimeGateMessages } from '../../../../../../../packages/api/src/shared/runtimeGateMessages';
import { topicExecutionNotice, topicFailureMessage } from './topic-notices';

const turnRefusal = (code: string, message: string) =>
  Object.assign(new Error(message), { data: { code, path: 'opc.topicTurn', retryAfter: 60 } });

it.each([
  ['TOO_MANY_REQUESTS', runtimeGateMessages.minute],
  ['TOO_MANY_REQUESTS', runtimeGateMessages.day],
  ['SERVICE_UNAVAILABLE', runtimeGateMessages.paused],
  ['SERVICE_UNAVAILABLE', runtimeGateMessages.limit_unavailable],
])('a refused topic turn (%s) shows the fixed notice instead of the unknown-state fallback', (code, message) => {
  const notice = topicFailureMessage(turnRefusal(code, message));
  expect(notice).toBe(message);
  expect(notice).not.toContain('状态待核实');
});

it('keeps existing topic failure wording for everything else', () => {
  expect(topicFailureMessage(new Error('OPC_REQUEST_CONFLICT'))).toContain('原请求身份');
  expect(topicFailureMessage(turnRefusal('SERVICE_UNAVAILABLE', '工作空间服务暂不可用，请稍后重试。'))).toContain('状态待核实');
  expect(topicFailureMessage(new Error('network'))).toContain('「重试」');
});

it.each([
  ['call_limited', runtimeGateMessages.minute],
  ['paused', runtimeGateMessages.paused],
  ['limit_unavailable', runtimeGateMessages.limit_unavailable],
])('reads the execute result reason %s', (unavailable, notice) => {
  expect(topicExecutionNotice({ state: 'cancelled', unavailable })).toBe(notice);
});

it('shows nothing for a normal or other execute result', () => {
  expect(topicExecutionNotice({ state: 'completed' })).toBeNull();
  expect(topicExecutionNotice({ state: 'cancelled', unavailable: 'capacity' })).toBeNull();
  expect(topicExecutionNotice(undefined)).toBeNull();
});
