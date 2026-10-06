/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { runtimeGateMessages } from '../../../../../../../packages/api/src/shared/runtimeGateMessages';
import { topicExecutionNotice, topicFailureMessage, topicTurnOutcome, topicOpenTurnNotice, topicRejectedTurn, topicTurnShows } from './topic-notices';
import { PROVIDER_REJECTED_NOTICE } from '@/lib/runtime-gate-notice';

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

const open = (state: string, extra: { busy?: boolean; finished?: string | null } = {}) =>
  topicOpenTurnNotice({ executionId: 'e1', state }, { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn(), ...extra });

it('keeps 正在回复… for a turn whose execute call finished before the view is re-read', () => {
  const notice = open('running', { finished: 'e1' });
  expect(notice).toMatchObject({ tone: 'status', busy: true, text: '正在回复…' });
  expect(notice?.actions?.map(action => action.disabled)).toEqual([true, false]);
  expect(open('completed', { finished: 'e1' })).toBeNull();
  // execute returned cost_pending and the view re-read it: the cost check stays available.
  const cost = open('cost_pending', { finished: 'e1' });
  expect(cost?.text).toBe('费用待核实；重试只核对原调用。');
  expect(cost?.actions?.map(action => action.disabled)).toEqual([false, false]);
  const interrupted = open('interrupted', { finished: 'e1' });
  expect(interrupted).toMatchObject({ tone: 'warning', text: '回复尚未完成，原请求已保留。' });
  expect(interrupted?.actions?.map(action => action.disabled)).toEqual([false, false]);
  expect(open('prepared', { finished: 'e1' })?.text).toBe('正在回复…');
});

it('says 回复尚未完成 for an open turn nothing is running, including another finished execution', () => {
  for (const notice of [open('interrupted'), open('running', { finished: 'other' })])
    expect(notice).toMatchObject({ tone: 'warning', busy: false, text: '回复尚未完成，原请求已保留。' });
  expect(open('running', { busy: true })?.text).toBe('正在回复…');
});
it('shows the provider refusal under a cancelled turn after a reload, without actions', () => {
  const refused = topicOpenTurnNotice({ executionId: 'e', state: 'cancelled', unavailableReason: 'provider_rejected' },
    { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn() });
  expect(refused).toEqual({ id: 'e', tone: 'warning', text: PROVIDER_REJECTED_NOTICE });
  expect(topicRejectedTurn({ state: 'cancelled', unavailableReason: 'provider_rejected' })).toBe(true);
  for (const unavailableReason of ['something_new', null, undefined]) {
    expect(topicOpenTurnNotice({ executionId: 'e', state: 'cancelled', unavailableReason },
      { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn() })).toBeNull();
    expect(topicRejectedTurn({ state: 'cancelled', unavailableReason })).toBe(false);
  }
  expect(topicExecutionNotice({ unavailable: 'provider_rejected' })).toBe(PROVIDER_REJECTED_NOTICE);
});
it('does not repeat the live refusal error once the last turn shows it', () => {
  expect(topicTurnShows({ state: 'cancelled', unavailableReason: 'provider_rejected' }, PROVIDER_REJECTED_NOTICE)).toBe(true);
  expect(topicTurnShows({ state: 'cancelled', unavailableReason: 'provider_rejected' }, '其他错误')).toBe(false);
  expect(topicTurnShows({ state: 'cancelled', unavailableReason: null }, PROVIDER_REJECTED_NOTICE)).toBe(false);
  expect(topicTurnShows(undefined, PROVIDER_REJECTED_NOTICE)).toBe(false);
});

it('leaves a paused topic turn to its pause notice', () => {
  for (const state of ['waiting_credits', 'waiting_resume'])
    expect(topicOpenTurnNotice({ executionId: 'e', state }, { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn() })).toBeNull();
});

it('shows the host notice first but keeps the typed input only after a gate stop (#698)', () => {
  const notice = '当前任务已停止，无法继续执行，请查看原任务。';
  expect(topicTurnOutcome({ state: 'cancelled', notice })).toEqual({ notice, keepInput: false });
  expect(topicTurnOutcome({ state: 'cancelled', unavailable: 'paused', notice })).toEqual({ notice, keepInput: true });
  expect(topicTurnOutcome({ state: 'cancelled', unavailable: 'paused' })).toEqual({ notice: runtimeGateMessages.paused, keepInput: true });
  expect(topicTurnOutcome({ state: 'completed' })).toEqual({ notice: null, keepInput: false });
  expect(topicTurnOutcome({ state: 'waiting_credits', notice: '余额不足，任务已暂停，请补充积分后继续。' })).toEqual({ notice: null, keepInput: false });
});
