/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runtimeGateMessages } from '../../../../packages/api/src/shared/runtimeGateMessages';
import { gateAdmissionNotice, gateResultNotice, isRuntimeGateReason } from './runtime-gate-notice';

const refusal = (code: string, message: string, path = 'runtime.prepare') =>
  Object.assign(new Error(message), { data: { code, path, retryAfter: 42 } });

describe('gateAdmissionNotice', () => {
  it.each([
    ['TOO_MANY_REQUESTS', runtimeGateMessages.minute, runtimeGateMessages.minute],
    ['TOO_MANY_REQUESTS', runtimeGateMessages.day, runtimeGateMessages.day],
    ['TOO_MANY_REQUESTS', '请求过于频繁，请在 42 秒后重试', runtimeGateMessages.minute],
    ['SERVICE_UNAVAILABLE', runtimeGateMessages.paused, runtimeGateMessages.paused],
    ['SERVICE_UNAVAILABLE', runtimeGateMessages.limit_unavailable, runtimeGateMessages.limit_unavailable],
  ])('maps %s "%s" to one fixed notice', (code, message, notice) => {
    expect(gateAdmissionNotice(refusal(code, message), ['runtime.prepare'])).toBe(notice);
  });

  it('never shows other server text and ignores other procedures and plain errors', () => {
    expect(gateAdmissionNotice(refusal('SERVICE_UNAVAILABLE', '工作空间服务暂不可用，请稍后重试。'), ['runtime.prepare'])).toBeNull();
    expect(gateAdmissionNotice(refusal('PRECONDITION_FAILED', runtimeGateMessages.paused), ['runtime.prepare'])).toBeNull();
    expect(gateAdmissionNotice(refusal('TOO_MANY_REQUESTS', runtimeGateMessages.minute, 'runtime.execute'), ['runtime.prepare']))
      .toBeNull();
    expect(gateAdmissionNotice(new Error(runtimeGateMessages.minute), ['runtime.prepare'])).toBeNull();
    expect(gateAdmissionNotice('TOO_MANY_REQUESTS', ['runtime.prepare'])).toBeNull();
  });
});

describe('gateResultNotice', () => {
  it('maps the three execution result reasons; call_limited always uses the minute text', () => {
    expect(gateResultNotice('call_limited')).toBe(runtimeGateMessages.minute);
    expect(gateResultNotice('paused')).toBe(runtimeGateMessages.paused);
    expect(gateResultNotice('limit_unavailable')).toBe(runtimeGateMessages.limit_unavailable);
    for (const other of ['capacity', 'preflight', 'output_truncated', undefined, null]) expect(gateResultNotice(other)).toBeNull();
    expect(['call_limited', 'paused', 'limit_unavailable'].every(isRuntimeGateReason)).toBe(true);
    expect(isRuntimeGateReason('capacity')).toBe(false);
  });
});
