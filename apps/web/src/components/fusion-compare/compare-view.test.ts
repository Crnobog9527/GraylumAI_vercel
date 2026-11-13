/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { columnPhase, compareErrorText, heldCredits, initialPick, isUpgradeRefusal, pickStatus, togglePick, type ReadColumn } from './compare-view';

const models = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id.toUpperCase() }));
const column = (patch: Partial<ReadColumn> = {}, call: Partial<NonNullable<ReadColumn['call']>> | null = {}): ReadColumn => ({
  column: 0, runId: 'r', modelId: 'm', body: null, billing: { reservedCredits: 9, chargedCredits: null, closed: false },
  call: call === null ? null : { callId: 'c', state: 'prepared', dispatched: false, verdict: null, ...call }, ...patch });

describe('compare picker rules (FUSION-COMPARE §3.3, Owner 2026-10-03 第 50 项)', () => {
  it('opens with the administrator default, only models still offered, at most the maximum, never filling gaps', () => {
    expect(initialPick({ models, defaultModelIds: ['b', 'gone', 'a'], maxModels: 4 })).toEqual(['b', 'a']);
    expect(initialPick({ models, defaultModelIds: ['a', 'b', 'c', 'd', 'e'], maxModels: 3 })).toEqual(['a', 'b', 'c']);
  });
  it('lets the user untick and tick, never past the maximum', () => {
    expect(togglePick(['a', 'b'], 'a', 3)).toEqual(['b']);
    expect(togglePick(['a', 'b'], 'c', 3)).toEqual(['a', 'b', 'c']);
    expect(togglePick(['a', 'b', 'c'], 'd', 3)).toEqual(['a', 'b', 'c']);
  });
  it('keeps the start button off below the minimum and says how many are missing', () => {
    expect(pickStatus(['a'], { minModels: 3, maxModels: 4 })).toEqual({ ready: false, hint: '请再勾选 2 个模型' });
    expect(pickStatus(['a', 'b', 'c'], { minModels: 3, maxModels: 4 }).ready).toBe(true);
  });
});

describe('compare refusals in plain words', () => {
  it('maps known codes and never shows anything raw', () => {
    expect(compareErrorText({ message: 'FUSION_COMPARE_ACTIVE' })).toBe('上一个多模型任务还在进行，结束后再开始新的对比。');
    expect(compareErrorText({ message: 'relation "x" does not exist' })).toBe('多模型对比暂时出了点问题，请稍后再试。');
    // FUSION-COMPARE: the 500-credit limit of one compare says so in words, and how to get under it.
    expect(compareErrorText({ message: 'TURN_COMPARE_LIMIT' })).toContain('超过了单次 500 积分的上限');
    expect(compareErrorText({ message: 'TURN_COMPARE_LIMIT' })).toContain('少选几个模型');
    expect(isUpgradeRefusal({ message: 'FUSION_COMPARE_FORBIDDEN' })).toBe(true);
    expect(isUpgradeRefusal({ message: 'FUSION_COMPARE_ACTIVE' })).toBe(false);
  });
});

describe('column phases (§3.5, §4.4)', () => {
  it('reads the three outcomes and the waiting states from the server view', () => {
    expect(columnPhase(column(), 'running')).toBe('queued');
    expect(columnPhase(column({}, { dispatched: true }), 'running')).toBe('pending');
    const closed = { reservedCredits: 9, chargedCredits: 3, state: 'settled', closed: true };
    expect(columnPhase(column({ body: '答', billing: closed }, { dispatched: true, verdict: 'usable' }), 'finished')).toBe('done');
    expect(columnPhase(column({ body: '答', billing: closed }, { dispatched: true }), 'finished')).toBe('done'); // saved, verdict not yet written
    // An answer or verdict whose settlement failed or whose cost is pending is not final: held credits, no adoption yet. A usable
    // answer says so as "积分结算中" (settling); any other verdict stays "结果待核对" (pending).
    expect(columnPhase(column({ body: '答' }, { dispatched: true, verdict: 'usable' }), 'running')).toBe('settling');
    expect(columnPhase(column({}, { dispatched: true, verdict: 'no_delivery' }), 'running')).toBe('pending');
    expect(columnPhase(column({ billing: { state: 'refunded', closed: true } }, { dispatched: true, verdict: 'no_delivery' }), 'finished')).toBe('failed');
    expect(columnPhase(column({ billing: { state: 'refunded', closed: true } }), 'stopped')).toBe('stopped');
  });
  it('shows the hold kept for an unknown result, nothing once the run is closed', () => {
    expect(heldCredits(column({}, { dispatched: true }))).toBe(9);
    expect(heldCredits(column({ billing: { reservedCredits: 9, chargedCredits: 3, state: 'settled', closed: true } }))).toBe(0);
  });
});

import { placeCompareCards } from './CompareThread';
describe('compare cards in the transcript', () => {
  const card = (id: string, turnId?: number) => ({ compareId: id, state: 'finished', createdAt: '2026-10-23T10:00:00Z',
    ...(turnId === undefined ? {} : { turnId }) });
  // The order the page shows: replies with each card before the reply it is keyed to, the rest after the last reply.
  const order = (cards: ReturnType<typeof card>[], replies: Array<{ turnId: number | null }>) => {
    const placed = placeCompareCards(cards, replies);
    return [...replies.flatMap((reply, index) => [...(placed.get(index) ?? []).map(c => c.compareId), `turn ${reply.turnId}`]),
      ...(placed.get(replies.length) ?? []).map(c => c.compareId)];
  };

  it('FUSION-COMPARE: a refreshed compare sits where it was asked, before its adopted answer and the follow-up, not at the bottom', () => {
    // Turn 10 asked first, compare turn 11 (its adopted question and answer are saved under turn 11), then follow-up turn 12.
    expect(order([card('cmp', 11)], [{ turnId: 10 }, { turnId: 11 }, { turnId: 12 }])).toEqual(['turn 10', 'cmp', 'turn 11', 'turn 12']);
    // Not adopted: the follow-up still comes after it.
    expect(order([card('cmp', 11)], [{ turnId: 10 }, { turnId: 12 }])).toEqual(['turn 10', 'cmp', 'turn 12']);
    // A compare as the first thing in the conversation, and two compares in a row.
    expect(order([card('a', 1), card('b', 2)], [{ turnId: 3 }])).toEqual(['a', 'b', 'turn 3']);
  });

  it('the same order before and after a refresh: a compare just started (no turn listed yet) and the newest one go last', () => {
    const live = order([card('old', 11), card('new')], [{ turnId: 10 }, { turnId: 12 }]);
    const refreshed = order([card('old', 11), card('new', 13)], [{ turnId: 10 }, { turnId: 12 }]);
    expect(live).toEqual(['turn 10', 'old', 'turn 12', 'new']);
    expect(refreshed).toEqual(live);
    // A reply without a turn (an older saved message) is never a place to put a card before.
    expect(order([card('cmp', 5)], [{ turnId: null }, { turnId: 6 }])).toEqual(['turn null', 'cmp', 'turn 6']);
  });
});

import { isDefiniteRefusal } from './compare-view';
describe('which failures spend the start request id', () => {
  it('a server refusal with a compare code does; a lost response or network failure does not', () => {
    expect(isDefiniteRefusal({ message: 'FUSION_COMPARE_TOO_FEW' })).toBe(true);
    expect(isDefiniteRefusal({ message: 'REPORT_MEMBERSHIP_REQUIRED' })).toBe(true);
    expect(isDefiniteRefusal({ message: 'POSITIONING_REQUIRED' })).toBe(true);
    expect(isDefiniteRefusal({ message: 'Failed to fetch' })).toBe(false);
    expect(isDefiniteRefusal(new Error('NetworkError when attempting to fetch resource.'))).toBe(false);
  });
});

import { allSettled, chargedCredits, stoppedLabel, totalChargedCredits } from './compare-view';
describe('a stopped column is never called free when it was charged', () => {
  const stopped = (charged: number | null): ReadColumn => ({ column: 0, runId: 'r', modelId: 'm', body: null,
    billing: { reservedCredits: 9, chargedCredits: charged, state: 'settled', closed: true }, call: { callId: 'c', state: 'settled', dispatched: true, verdict: 'user_stopped' } });
  it('user_stopped is a stop, with wording that follows what was charged', () => {
    expect(columnPhase(stopped(4), 'stopped')).toBe('stopped');
    // Closed billing is what makes a stop final; before that its hold is still held.
    const open = stopped(null); open.billing = { reservedCredits: 9, chargedCredits: null, closed: false };
    expect(columnPhase(open, 'stopped')).toBe('pending');
    expect(heldCredits(open)).toBe(9);
    expect(allSettled([stopped(4), open])).toBe(false);
    expect(allSettled([stopped(4), stopped(0)])).toBe(true);
    expect(stoppedLabel(stopped(4))).toBe('已停止，按已生成部分计费 4 积分');
    expect(stoppedLabel(stopped(0))).toBe('已停止，不收费');
    expect(stoppedLabel(stopped(null))).toBe('已停止，不收费');
  });
  it('an unavailable server code keeps the start request id', () => {
    expect(isDefiniteRefusal({ message: 'FUSION_ADMISSION_UNAVAILABLE' })).toBe(false);
    expect(isDefiniteRefusal({ message: 'FUSION_SETTINGS_UNAVAILABLE' })).toBe(false);
    expect(isDefiniteRefusal({ message: 'FUSION_COMPARE_PRICE_CHANGED' })).toBe(true);
    // Every code after which the server keeps the request's record or group recoverable keeps the id too (compareStart KEEP_RECORD).
    for (const code of ['FUSION_COMPARE_ACTIVE', 'FUSION_COMPARE_DENIED', 'FUSION_COMPARE_ENDED', 'FUSION_COMPARE_REQUEST_CONFLICT',
      'FUSION_GROUP_CONFLICT', 'BILL2_REQUEST_CONFLICT']) expect(isDefiniteRefusal({ message: code })).toBe(false);
  });
});

import { withStarted } from './CompareThread';
describe('a compare this tab started stays visible while the list is unreadable', () => {
  const card = (id: string, state: string) => ({ compareId: id, state, createdAt: '2026-10-23T10:00:00Z' });
  it('adds the started compare when the list lacks it, and lets the listed card win once it appears', () => {
    expect(withStarted([], [card('a', 'running')]).map(c => c.compareId)).toEqual(['a']);
    expect(withStarted([card('a', 'finished')], [card('a', 'running')])).toEqual([card('a', 'finished')]);
    expect(withStarted([card('b', 'finished')], [card('a', 'running')]).map(c => c.compareId)).toEqual(['b', 'a']);
  });
});

// Real BILL2 cancellation closes dispatch immediately; provider settlement can arrive later.
describe('stop waits for financial settlement, not just dispatch closure', () => {
  const waiting = (): ReadColumn => column({ billing: { state: 'cost_pending', closed: true,
    reservedCredits: 64, chargedCredits: 0, outcome: 'cancelled' } }, { dispatched: true, verdict: null });
  it('keeps polling and the full hold while a stopped column awaits its receipt', () => {
    expect(columnPhase(waiting(), 'stopped')).toBe('pending');
    expect(allSettled([waiting()])).toBe(false);
    expect(heldCredits(waiting())).toBe(64);
  });
  it('a stopped column with known usage is charged even when no body was saved', () => {
    const settled = waiting();
    settled.billing = { ...settled.billing, state: 'settled', chargedCredits: 10 };
    settled.call!.verdict = 'user_stopped';
    expect(allSettled([settled])).toBe(true);
    expect(columnPhase(settled, 'stopped')).toBe('stopped');
    expect(stoppedLabel(settled)).toContain('10 积分');
  });
});


it('column charges and the total use the ledger net after compensation', () => {
  const first = column({ billing: { state: 'settled', closed: true, chargedCredits: 10, netChargedCredits: 7 } });
  const second = column({ billing: { state: 'settled', closed: true, chargedCredits: 10, netChargedCredits: 10 } });
  expect(chargedCredits(first)).toBe(7);
  expect(totalChargedCredits([first, second])).toBe(17);
});
