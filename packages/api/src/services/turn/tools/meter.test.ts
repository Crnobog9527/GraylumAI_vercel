/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { TurnDatabaseError } from '../db';
import { paidToolCall, settleToolCall, ToolLimitReached } from './meter';
import { ledger, result } from './testFixtures.test';
import type { SubcallReceipt } from './types';

const r = (over: Partial<SubcallReceipt['result']>, costUsd: string | null = '0.001', multiplier = '6'): SubcallReceipt =>
  ({ result: result({ vendor: 'tikhub', route: 'xhs', ...over }), costUsd, multiplier });
const call = { toolName: 'social_search', requestHash: 'h'.repeat(64), upperUsd: '0.003', multiplier: '6' };

describe('settling one tool call from its subcalls (CORE-PATH-V2 V2-6)', () => {
  it('nothing sent: not_sent', () => {
    expect(settleToolCall([], '6')).toEqual({ outcome: 'not_sent' });
    expect(settleToolCall([r({ outcome: 'not_sent', items: [] }, '0')], '6')).toEqual({ outcome: 'not_sent' });
  });
  it('data came back: the user pays the summed cost of every subcall of the call', () => {
    expect(settleToolCall([r({}), r({ items: [] })], '6')).toEqual({ outcome: 'delivered', nominalUsd: '0.002', actualUsd: '0.002' });
  });
  it('a route with a smaller multiplier than the row is weighted down, never overcharged', () => {
    // 0.001 x 6 + 0.001 x 3 = 0.009 credits-base at m 6 → n = 0.0015.
    expect(settleToolCall([r({}), r({}, '0.001', '3')], '6')).toMatchObject({ outcome: 'delivered', nominalUsd: '0.0015' });
  });
  it('ran but no data ("这次没取到数据"): no_data, the user pays nothing, the platform cost is kept', () => {
    expect(settleToolCall([r({ items: [], reason: 'NO_RESULTS' })], '6')).toEqual({ outcome: 'no_data', actualUsd: '0.001' });
    expect(settleToolCall([r({ outcome: 'failed', items: [] }, '0')], '6')).toEqual({ outcome: 'no_data', actualUsd: '0' });
  });
  it('any unknown subcall, or a delivered one without official usage, leaves the whole call unknown', () => {
    expect(settleToolCall([r({}), r({ outcome: 'unknown', items: [] }, null)], '6')).toEqual({ outcome: 'unknown' });
    expect(settleToolCall([r({}, null)], '6')).toEqual({ outcome: 'unknown' });
  });
});

describe('one paid tool call is one row: begin, subcalls, record (2.5.2)', () => {
  it('delivered: begin before any subcall, one ok receipt with n and c', async () => {
    const h = ledger();
    let begunFirst = false;
    const out = await paidToolCall(h.deps, call, async l => { begunFirst = h.writes.length === 1; l.add(r({})); l.add(r({})); return 'x'; });
    expect(begunFirst).toBe(true);
    expect(out).toEqual({ value: 'x', outcome: 'delivered' });
    expect(h.kinds()).toEqual(['begin', 'record:ok']);
    expect(h.writes[0]![1]).toMatchObject({ callKind: 'tool', paid: true, toolName: 'social_search', upperUsd: '0.003', seq: 1 });
    expect(h.writes[1]![1]).toMatchObject({ nominalUsd: '0.002', actualUsd: '0.002', providerId: null });
    expect(h.writes[1]![1].usage).toMatchObject({ subcalls: 2, outcome: 'delivered' });
  });

  it('no data: an unusable receipt (user base 0, platform cost kept)', async () => {
    const h = ledger();
    const out = await paidToolCall(h.deps, call, async l => { l.add(r({ items: [] })); });
    expect(out.outcome).toBe('no_data');
    expect(h.kinds()).toEqual(['begin', 'record:unusable']);
    expect(h.writes[1]![1]).toMatchObject({ nominalUsd: null, actualUsd: '0.001' });
  });

  it('unknown: no receipt is written, so turn_close marks it unknown (user 0, reserve held for recovery)', async () => {
    const h = ledger();
    const out = await paidToolCall(h.deps, call, async l => { l.add(r({ outcome: 'unknown', items: [] }, null)); });
    expect(out.outcome).toBe('unknown');
    expect(h.kinds()).toEqual(['begin']);
  });

  it('nothing sent: a not_sent receipt (free, not counted against the limit)', async () => {
    const h = ledger();
    await paidToolCall(h.deps, call, async l => { l.add(r({ outcome: 'not_sent', items: [] }, '0')); });
    expect(h.kinds()).toEqual(['begin', 'record:not_sent']);
  });

  it('a failure inside the call still records what was sent before the error passes', async () => {
    const h = ledger();
    await expect(paidToolCall(h.deps, call, async l => { l.add(r({})); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(h.kinds()).toEqual(['begin', 'record:ok']);
  });

  it('paused for credits: nothing is sent and the turn stops', async () => {
    const h = ledger({ begin: () => ({ state: 'paused', paused: true }) });
    let ran = false;
    await expect(paidToolCall(h.deps, call, async () => { ran = true; })).rejects.toThrow('TURN_PAUSED_FOR_CREDITS');
    expect(ran).toBe(false);
  });

  it('deleted after the turn opened: the row is closed as not sent and the turn stops', async () => {
    const h = ledger({ begin: () => ({ sessionTombstoned: true }) });
    await expect(paidToolCall(h.deps, call, async () => undefined)).rejects.toThrow('TURN_TOMBSTONED');
    expect(h.kinds()).toEqual(['begin', 'record:not_sent']);
  });

  it('a tombstone on the receipt stops the turn after the cost is recorded', async () => {
    const h = ledger({ record: () => ({ accountErasing: true }) });
    await expect(paidToolCall(h.deps, call, async l => { l.add(r({})); })).rejects.toThrow('TURN_TOMBSTONED');
    expect(h.kinds()).toEqual(['begin', 'record:ok']);
  });

  it('the database refuses past the frozen limit: nothing written, nothing sent', async () => {
    const h = ledger({ begin: () => new TurnDatabaseError('TURN_CALL_LIMIT') });
    await expect(paidToolCall(h.deps, call, async () => undefined)).rejects.toBeInstanceOf(ToolLimitReached);
    expect(h.writes).toEqual([]);
  });
});
