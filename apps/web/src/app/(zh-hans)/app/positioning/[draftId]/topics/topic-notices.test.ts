/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { runtimeGateMessages } from '../../../../../../../../../packages/api/src/shared/runtimeGateMessages';
import { topicExecutionNotice, topicExplained, topicFailureMessage, topicReplyText, topicTurnOutcome, topicOpenTurnNotice, topicRejectedTurn, topicTurnRefused, topicTurnShows } from './topic-notices';
import { PROVIDER_REJECTED_NOTICE } from '@/lib/runtime-gate-notice';
import { DEFINITE_REFUSAL_NOTICE } from '@/app/(zh-hans)/app/runtime/gate-notices';
import { ENDED_NOTICE, USER_STOP_NOTICE } from '@/app/(zh-hans)/app/runtime/runtime-notices';
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
  // Any other cancelled turn the server ended says so, like free conversation (ENDED_NOTICE), never nothing.
  for (const unavailableReason of ['something_new', null, undefined]) {
    expect(topicOpenTurnNotice({ executionId: 'e', state: 'cancelled', unavailableReason },
      { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn() })).toEqual({ id: 'e', tone: 'warning', text: ENDED_NOTICE });
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

const refused = (httpStatus: number, code: string, message: string, path = 'opc.topicTurn') =>
  Object.assign(new Error(message), { data: { httpStatus, code, path } });

it('a topic turn refused before admission says why and is released, never shown as unknown', () => {
  const payg = refused(412, 'PRECONDITION_FAILED', RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE);
  expect(topicFailureMessage(payg)).toBe(RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE);
  expect(topicTurnRefused(payg)).toBe(true);
  const other = refused(412, 'PRECONDITION_FAILED', '当前测试窗口已过期。');
  expect(topicFailureMessage(other)).toBe(DEFINITE_REFUSAL_NOTICE);
  expect(topicTurnRefused(other)).toBe(true);
});

it('keeps unknown outcomes, rate limits, identity conflicts and other procedures held', () => {
  for (const cause of [refused(503, 'SERVICE_UNAVAILABLE', 'x'), refused(500, 'INTERNAL_SERVER_ERROR', 'x'),
    refused(429, 'TOO_MANY_REQUESTS', runtimeGateMessages.minute), refused(409, 'CONFLICT', 'OPC_REQUEST_CONFLICT'),
    refused(412, 'PRECONDITION_FAILED', 'x', 'opc.saveTopicDraft'), new Error('network'),
    refused(412, 'PRECONDITION_FAILED', 'RUNTIME_ORGANIZER_PENDING：上一轮整理尚未完成，新消息尚未准入，请先处理原任务。')])
    expect(topicTurnRefused(cause)).toBe(false);
  expect(topicFailureMessage(refused(503, 'SERVICE_UNAVAILABLE', 'x'))).toContain('状态待核实');
});

// #973 Codex step 3: a stopped topic turn says 已停止 from the click on, never 回复尚未完成.
it('a stopped topic turn says 已停止 in every state and never reads as unfinished', () => {
  const ctx = (extra = {}) => ({ busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn(), ...extra });
  const savedStop = { billing: { pausedReason: 'user_stop', cancelRequested: false } };
  const cases = [
    topicOpenTurnNotice({ executionId: 'e', state: 'running' }, ctx({ userStopped: true })),
    topicOpenTurnNotice({ executionId: 'e', state: 'running', userStopPending: true }, ctx()),
    topicOpenTurnNotice({ executionId: 'e', state: 'cancelled' }, ctx({ userStopped: true })),
    topicOpenTurnNotice({ executionId: 'e', state: 'completed', stopped: true, ...savedStop }, ctx()),
  ];
  for (const notice of cases) {
    expect(notice).toMatchObject({ tone: 'status', text: USER_STOP_NOTICE });
    expect(notice?.actions).toBeUndefined();
  }
  // A save the server left interrupted offers 重试 to finish it.
  const interrupted = topicOpenTurnNotice({ executionId: 'e', state: 'interrupted', userStopPending: true }, ctx());
  expect(interrupted?.text).toBe(USER_STOP_NOTICE);
  expect(interrupted?.actions?.map(action => action.label)).toEqual(['重试']);
  // A stop only this tab knows about offers no 重试: without the server's record it could resume charged work.
  const unconfirmed = topicOpenTurnNotice({ executionId: 'e', state: 'interrupted' }, ctx({ userStopped: true }));
  expect(unconfirmed).toMatchObject({ text: USER_STOP_NOTICE });
  expect(unconfirmed?.actions).toBeUndefined();
  // A cost still being verified keeps its own notice and retry.
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'cost_pending', userStopPending: true }, ctx())?.text).toBe('费用待核实；重试只核对原调用。');
  // Without any stop record it never says 已停止: a completed turn shows nothing, a cancelled one that it ended,
  // an open one is still unfinished.
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'completed' }, ctx())).toBeNull();
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'cancelled' }, ctx())?.text).toBe(ENDED_NOTICE);
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'running' }, ctx())?.text).toBe('回复尚未完成，原请求已保留。');
  // An ordinary cancellation that once paused for a stop is not a user stop.
  const cancelledPause = { billing: { pausedReason: 'user_stop', cancelRequested: true } };
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'cancelled', ...cancelledPause }, ctx())?.text).toBe(ENDED_NOTICE);
});

// A turn stopped before its first word is cancelled, refunded and closed: nothing is left to verify.
it('never shows the verifying placeholder for a finished turn without a reply (execution 4ae0eb5b)', () => {
  const stoppedEarly = { executionId: 'e', state: 'cancelled', body: null, primaryBody: null, contentAvailable: true,
    unavailableReason: null, billing: { pausedReason: null, cancelRequested: true } };
  expect(topicReplyText(stoppedEarly)).toBeNull();
  // Reopened in another browser: the server ended it, the turn says so.
  expect(topicOpenTurnNotice(stoppedEarly, { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn() }))
    .toEqual({ id: 'e', tone: 'warning', text: ENDED_NOTICE });
  // The tab that clicked 停止 keeps 已停止.
  expect(topicOpenTurnNotice(stoppedEarly, { busy: false, finished: null, stopping: false, userStopped: true, onRetry: vi.fn(), onStop: vi.fn() })?.text)
    .toBe(USER_STOP_NOTICE);
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

// #1035 review: a PAYG turn whose main reply is saved but whose organizer was skipped keeps only its own notice.
it('does not say 已结束 under a saved reply whose organizer was skipped', () => {
  const skipped = { executionId: 'e', state: 'cancelled', primaryBody: '主回复', organizerComplete: false, remainingCalls: 0 };
  expect(topicOpenTurnNotice(skipped, { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn() })).toBeNull();
  expect(topicOpenTurnNotice({ ...skipped, remainingCalls: 1 }, { busy: false, finished: null, stopping: false, onRetry: vi.fn(), onStop: vi.fn() })?.text)
    .toBe(ENDED_NOTICE);
});

// #1035 review: while this tab shows the execute result's own reason (gate, host notice), the turn adds no 已结束.
it('does not pair 已结束 with the live cancellation reason this tab already shows', () => {
  const ctx = (explained?: boolean) => ({ busy: false, finished: null, stopping: false, explained, onRetry: vi.fn(), onStop: vi.fn() });
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'cancelled' }, ctx(true))).toBeNull();
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'cancelled' }, ctx(false))?.text).toBe(ENDED_NOTICE);
  expect(topicOpenTurnNotice({ executionId: 'e', state: 'cancelled' }, { ...ctx(true), userStopped: true })?.text).toBe(USER_STOP_NOTICE);
  expect(topicExplained({ id: 'e', text: '暂停' }, 'e', '暂停')).toBe(true);
  expect(topicExplained({ id: 'e', text: '暂停' }, 'e', '')).toBe(false);
  expect(topicExplained({ id: 'e', text: '暂停' }, 'other', '暂停')).toBe(false);
  expect(topicExplained(null, 'e', '暂停')).toBe(false);
});
