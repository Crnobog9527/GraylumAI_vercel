/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { runtimeGateMessages } from '../../../../../../../../../packages/api/src/shared/runtimeGateMessages';
import { topicFailureMessage, topicReplyText } from './topic-notices';
import { DEFINITE_REFUSAL_NOTICE } from '@/app/(zh-hans)/app/runtime/gate-notices';
import { RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE } from '../../../../../../../../../packages/api/src/shared/runtimeAdmissionMessages';

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

const refused = (httpStatus: number, code: string, message: string, path = 'opc.topicTurn') =>
  Object.assign(new Error(message), { data: { httpStatus, code, path } });

it('a topic turn refused before admission says why, never shown as unknown', () => {
  const payg = refused(412, 'PRECONDITION_FAILED', RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE);
  expect(topicFailureMessage(payg)).toBe(RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE);
  const other = refused(412, 'PRECONDITION_FAILED', '当前测试窗口已过期。');
  expect(topicFailureMessage(other)).toBe(DEFINITE_REFUSAL_NOTICE);
});

// A turn stopped before its first word is cancelled, refunded and closed: nothing is left to verify.
it('never shows the verifying placeholder for a finished turn without a reply (execution 4ae0eb5b)', () => {
  const stoppedEarly = { executionId: 'e', state: 'cancelled', body: null, primaryBody: null, contentAvailable: true,
    unavailableReason: null, billing: { pausedReason: null, cancelRequested: true } };
  expect(topicReplyText(stoppedEarly)).toBeNull();
  // In progress without text yet: only its own 正在回复… notice; a pause only its pause notice.
  for (const state of ['prepared', 'running', 'interrupted', 'cost_pending', 'waiting_credits', 'waiting_resume'])
    expect(topicReplyText({ ...stoppedEarly, state })).toBeNull();
  for (const state of ['cancelled', 'completed', 'running']) {
    const text = topicReplyText({ ...stoppedEarly, state, body: '回复' });
    expect(text).toBe('回复');
    expect(text).not.toContain('正在核实');
  }
  expect(topicReplyText({ ...stoppedEarly, state: 'interrupted', primaryBody: '主回复' })).toBe('主回复');
  expect(topicReplyText({ ...stoppedEarly, state: 'completed', body: '说明\n```json\n[{"id":"x"}]\n```' })).toBe('说明');
  expect(topicReplyText({ ...stoppedEarly, state: 'completed', body: '回复', contentAvailable: false })).toBe('来源已不可用，暂不展示此内容。');
  expect(topicReplyText({ ...stoppedEarly, state: 'completed' })).toBe('');
});
