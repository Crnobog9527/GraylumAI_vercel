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
    expect(isUpgradeRefusal({ message: 'FUSION_COMPARE_FORBIDDEN' })).toBe(true);
    expect(isUpgradeRefusal({ message: 'FUSION_COMPARE_ACTIVE' })).toBe(false);
  });
});

describe('column phases (§3.5, §4.4)', () => {
  it('reads the three outcomes and the waiting states from the server view', () => {
    expect(columnPhase(column(), 'running')).toBe('queued');
    expect(columnPhase(column({}, { dispatched: true }), 'running')).toBe('pending');
    expect(columnPhase(column({ body: '答' }, { dispatched: true, verdict: 'usable' }), 'finished')).toBe('done');
    expect(columnPhase(column({ body: '答' }, { dispatched: true }), 'running')).toBe('done'); // saved, verdict not yet written
    expect(columnPhase(column({ billing: { closed: true } }, { dispatched: true, verdict: 'no_delivery' }), 'finished')).toBe('failed');
    expect(columnPhase(column({ billing: { closed: true } }), 'stopped')).toBe('stopped');
  });
  it('shows the hold kept for an unknown result, nothing once the run is closed', () => {
    expect(heldCredits(column({}, { dispatched: true }))).toBe(9);
    expect(heldCredits(column({ billing: { reservedCredits: 9, chargedCredits: 3, closed: true } }))).toBe(0);
  });
});

import { placeCompareCards } from './CompareThread';
describe('compare cards in the transcript', () => {
  it('sit after the last turn that started before them', () => {
    const card = (id: string, createdAt: string) => ({ compareId: id, state: 'finished', createdAt });
    const turns = [{ createdAt: '2026-10-23T10:00:00Z' }, { createdAt: '2026-10-23T10:05:00Z' }];
    const placed = placeCompareCards([card('a', '2026-10-23T09:00:00Z'), card('b', '2026-10-23T10:01:00Z'), card('c', '2026-10-23T11:00:00Z')], turns);
    expect(placed.get(-1)?.map(c => c.compareId)).toEqual(['a']);
    expect(placed.get(0)?.map(c => c.compareId)).toEqual(['b']);
    expect(placed.get(1)?.map(c => c.compareId)).toEqual(['c']);
  });
});

import { isDefiniteRefusal } from './compare-view';
describe('which failures spend the start request id', () => {
  it('a server refusal with a compare code does; a lost response or network failure does not', () => {
    expect(isDefiniteRefusal({ message: 'FUSION_COMPARE_ACTIVE' })).toBe(true);
    expect(isDefiniteRefusal({ message: 'REPORT_MEMBERSHIP_REQUIRED' })).toBe(true);
    expect(isDefiniteRefusal({ message: 'POSITIONING_REQUIRED' })).toBe(true);
    expect(isDefiniteRefusal({ message: 'Failed to fetch' })).toBe(false);
    expect(isDefiniteRefusal(new Error('NetworkError when attempting to fetch resource.'))).toBe(false);
  });
});

import { stoppedLabel } from './compare-view';
describe('a stopped column is never called free when it was charged', () => {
  const stopped = (charged: number | null): ReadColumn => ({ column: 0, runId: 'r', modelId: 'm', body: null,
    billing: { reservedCredits: 9, chargedCredits: charged, closed: true }, call: { callId: 'c', state: 'settled', dispatched: true, verdict: 'user_stopped' } });
  it('user_stopped is a stop, with wording that follows what was charged', () => {
    expect(columnPhase(stopped(4), 'stopped')).toBe('stopped');
    expect(stoppedLabel(stopped(4))).toBe('已停止，按已生成的部分计费 4 积分');
    expect(stoppedLabel(stopped(0))).toBe('已停止，不收费');
    expect(stoppedLabel(stopped(null))).toBe('已停止，不收费');
  });
  it('an unavailable server code keeps the start request id', () => {
    expect(isDefiniteRefusal({ message: 'FUSION_ADMISSION_UNAVAILABLE' })).toBe(false);
    expect(isDefiniteRefusal({ message: 'FUSION_SETTINGS_UNAVAILABLE' })).toBe(false);
    expect(isDefiniteRefusal({ message: 'FUSION_COMPARE_PRICE_CHANGED' })).toBe(true);
  });
});
