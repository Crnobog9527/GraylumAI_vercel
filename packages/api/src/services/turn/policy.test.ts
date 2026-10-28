/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { callCredits, turnPolicy } from './policy';

const base = { q: '100', multiplier: '6', modelUpperUsd: '0.05', historyItems: 100, inputBytes: 90000,
  stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } };

describe('turn policy (CORE-PATH-V2 2.5.3, Fable 10-28)', () => {
  it('G_i = ceil(q x U x m) exactly, rounding up', () => {
    expect(callCredits('100', '0.05', '6')).toBe(30);
    expect(callCredits('100', '0.000000000001', '1.5')).toBe(1);
  });

  it('the positioning check is outside M and the freeze, but its upper bound is in U_turn', () => {
    const p = turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 1 }, decisionUpperUsd: '0.001' });
    expect(p).toMatchObject({ gCredits: 30, uModelCredits: 30, minCredits: 30, uTurnUsd: 0.051, decisionUpperUsd: '0.001' });
    expect(turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 } }))
      .toMatchObject({ gCredits: 30, uTurnUsd: 0.05 });
  });

  it('refuses limits that do not add up and a check without its bound', () => {
    expect(() => turnPolicy({ ...base, limits: { model: 2, paidTools: 0, freeTools: 0, decisions: 1 }, decisionUpperUsd: '0.001' })).toThrow();
    expect(() => turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 1 } })).toThrow('TURN_POLICY_INVALID');
    expect(() => turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, decisionUpperUsd: '0.001' }))
      .toThrow('TURN_POLICY_INVALID');
  });
});
