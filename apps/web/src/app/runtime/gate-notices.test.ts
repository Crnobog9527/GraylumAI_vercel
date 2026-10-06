/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runtimeGateMessages } from '../../../../../packages/api/src/shared/runtimeGateMessages';
import {
  OUTPUT_TRUNCATED_NOTICE, rememberUserStop, runtimeAdmissionNotice, runtimeExecutionNotice, userStopIds, videoGateError, videoGateNotice,
} from './gate-notices';

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

import { gateStopNotices, rememberGateStop, showsReply } from './gate-notices';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

it.each([
  ['call_limited', runtimeGateMessages.minute],
  ['paused', runtimeGateMessages.paused],
  ['limit_unavailable', runtimeGateMessages.limit_unavailable],
])('a %s stop keeps its fixed notice for the cancelled round after a reload', (unavailable, notice) => {
  const storage = memoryStorage();
  expect(rememberGateStop(storage, 'session', 'stopped', { state: 'cancelled', unavailable })).toBe(notice);
  const executions = [{ executionId: 'stopped', state: 'cancelled' }, { executionId: 'other', state: 'cancelled' }];
  expect(gateStopNotices(storage, 'session', executions)).toEqual({ stopped: notice });
  // Another session or a non-cancelled state never borrows the notice.
  expect(gateStopNotices(storage, 'another', executions)).toEqual({});
  expect(gateStopNotices(storage, 'session', [{ executionId: 'stopped', state: 'running' }])).toEqual({});
});

it('remembers nothing for other results and survives missing or failing storage', () => {
  const storage = memoryStorage();
  expect(rememberGateStop(storage, 'session', 'a', { state: 'cancelled', unavailable: 'capacity' })).toBeNull();
  expect(rememberGateStop(storage, 'session', 'b', { state: 'completed' })).toBeNull();
  expect(gateStopNotices(storage, 'session', [{ executionId: 'a', state: 'cancelled' }])).toEqual({});
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  expect(rememberGateStop(broken, 'session', 'c', { state: 'cancelled', unavailable: 'paused' })).toBe(runtimeGateMessages.paused);
  expect(gateStopNotices(broken, 'session', [{ executionId: 'c', state: 'cancelled' }])).toEqual({});
  expect(rememberGateStop(null, 'session', 'd', { state: 'cancelled', unavailable: 'paused' })).toBe(runtimeGateMessages.paused);
});

it('shows no "verifying" reply for a cancelled round without a body, and keeps every other reply', () => {
  expect(showsReply({ state: 'cancelled', body: null, primaryBody: null })).toBe(false);
  expect(showsReply({ state: 'cancelled', body: null, primaryBody: '已保存的主回复' })).toBe(true);
  expect(showsReply({ state: 'running', body: null, primaryBody: null })).toBe(true);
  expect(showsReply({ state: 'completed', body: '回复', primaryBody: null })).toBe(true);
});

import { definiteRefusal } from './gate-notices';

const structured = (httpStatus: number, code: string, path = 'runtime.prepare') =>
  Object.assign(new Error('fixed refusal'), { data: { httpStatus, code, path } });

it.each([
  [412, 'PRECONDITION_FAILED'], [403, 'FORBIDDEN'], [409, 'CONFLICT'], [400, 'BAD_REQUEST'], [404, 'NOT_FOUND'],
])('treats a structured %i %s as a definite refusal', (status, code) => {
  expect(definiteRefusal(structured(status, code))).toEqual({ path: 'runtime.prepare' });
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

describe('user stops', () => {
  const memory = () => { const items = new Map<string, string>(); return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); } }; };
  it('remembers only the stops this browser requested, per session', () => {
    const storage = memory();
    rememberUserStop(storage, 's1', 'e1');
    const executions = [{ executionId: 'e1' }, { executionId: 'e2' }];
    expect(userStopIds(storage, 's1', executions)).toEqual(['e1']);
    expect(userStopIds(storage, 's2', executions)).toEqual([]);
  });
  it('treats missing or failing storage as no user stop', () => {
    expect(userStopIds(null, 's1', [{ executionId: 'e1' }])).toEqual([]);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => rememberUserStop(broken, 's1', 'e1')).not.toThrow();
    expect(userStopIds(broken, 's1', [{ executionId: 'e1' }])).toEqual([]);
  });
});

it('explains a pre-dispatch history refusal with an actionable next step', () => {
 const notice=runtimeExecutionNotice({state:'cancelled',unavailable:'provider_history'});
 expect(notice).toContain('请新开一个对话');expect(notice).not.toContain('已停止');
});

describe('paused rounds', () => {
  it('show no reply until a body is saved', () => {
    expect(showsReply({ state: 'waiting_credits', body: null, primaryBody: null })).toBe(false);
    expect(showsReply({ state: 'waiting_resume', body: null, primaryBody: null })).toBe(false);
    expect(showsReply({ state: 'waiting_credits', body: null, primaryBody: '主回复' })).toBe(true);
  });
});

it('shows the host notice first and only otherwise the gate notice (#698)', () => {
  const notice = '当前任务已停止，无法继续执行，请查看原任务。';
  expect(runtimeExecutionNotice({ state: 'cancelled', unavailable: 'paused', notice })).toBe(notice);
  expect(runtimeExecutionNotice({ state: 'cancelled', notice })).toBe(notice);
  expect(runtimeExecutionNotice({ state: 'waiting_credits', notice: '余额不足，任务已暂停，请补充积分后继续。' })).toBeNull();
  expect(runtimeExecutionNotice({ state: 'cancelled', unavailable: 'provider_history' })).toBe(runtimeExecutionNotice({ unavailable: 'provider_history' }));
});
