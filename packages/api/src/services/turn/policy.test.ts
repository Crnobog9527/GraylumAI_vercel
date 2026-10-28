/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { callCredits, startThresholdCredits, turnPolicy } from './policy';

const base = { q: '100', multiplier: '6', modelUpperUsd: '0.05', historyItems: 100, inputBytes: 90000, startThresholdCredits: 12,
  stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } };

describe('turn policy (CORE-PATH-V2 2.5.3, Fable 10-28)', () => {
  it('G_i = ceil(q x U x m) exactly, rounding up', () => {
    expect(callCredits('100', '0.05', '6')).toBe(30);
    expect(callCredits('100', '0.000000000001', '1.5')).toBe(1);
  });

  it('the positioning check is outside M and the freeze, but its upper bound is in U_turn', () => {
    const p = turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 1 }, decisionUpperUsd: '0.001' });
    expect(p).toMatchObject({ gCredits: 30, uModelCredits: 30, minCredits: 12, uTurnUsd: 0.051, decisionUpperUsd: '0.001' });
    expect(turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 } }))
      .toMatchObject({ gCredits: 30, uTurnUsd: 0.05 });
  });

  it('refuses limits that do not add up and a check without its bound', () => {
    expect(() => turnPolicy({ ...base, limits: { model: 2, paidTools: 0, freeTools: 0, decisions: 1 }, decisionUpperUsd: '0.001' })).toThrow();
    expect(() => turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 1 } })).toThrow('TURN_POLICY_INVALID');
    expect(() => turnPolicy({ ...base, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 }, decisionUpperUsd: '0.001' }))
      .toThrow('TURN_POLICY_INVALID');
  });

  it('the start threshold L is the configured one (Owner 10-01, 10-28), never the call bound', () => {
    expect(() => turnPolicy({ ...base, startThresholdCredits: 0, limits: { model: 1, paidTools: 0, freeTools: 0, decisions: 0 } }))
      .toThrow('TURN_POLICY_INVALID');
    const setting = { version: 'v1', thresholds: [
      { model: 'm/a', purpose: 'ordinary', typicalUsd: '0.04415' }, { model: 'm/b', purpose: 'ordinary', credits: 25 },
      { model: 'm/c', purpose: 'ordinary', typicalUsd: '0' }, { model: 'm/d', purpose: 'ordinary', typicalUsd: '1' },
      { model: 'm/d', purpose: 'ordinary', typicalUsd: '2' }] };
    expect(startThresholdCredits(setting, 'm/a', 'ordinary', '100', '3')).toBe(14); // ceil(0.04415 x 100 x 3), as bill2_payg_claim
    expect(startThresholdCredits(setting, 'm/b', 'ordinary', '100', '3')).toBe(25); // a legacy entry keeps its credits
    expect(startThresholdCredits(setting, 'm/c', 'ordinary', '100', '3')).toBe(1);  // at least 1
    expect(startThresholdCredits(setting, 'm/d', 'ordinary', '100', '3')).toBeUndefined(); // duplicated
    expect(startThresholdCredits(setting, 'm/a', 'skill', '100', '3')).toBeUndefined(); // not configured for this purpose
    expect(startThresholdCredits(null, 'm/a', 'ordinary', '100', '3')).toBeUndefined();
    expect(startThresholdCredits({ version: 'v1', thresholds: [{ model: 'm/a', purpose: 'ordinary', typicalUsd: '1', credits: 3 }] },
      'm/a', 'ordinary', '100', '3')).toBeUndefined(); // both forms: invalid, never a guess
  });

  it('V2-5: a call on another model (the mentor organizer) has its own bound and multiplier, in M, G and U_turn', () => {
    const p = turnPolicy({ ...base, limits: { model: 3, paidTools: 0, freeTools: 1, decisions: 0 },
      otherModelCalls: [{ upperUsd: '0.01', multiplier: '2' }] });
    // 2 x 30 (mentor) + ceil(100 x 0.01 x 2) = 62 credits; 2 x 0.05 + 0.01 USD.
    expect(p).toMatchObject({ gCredits: 62, uModelCredits: 30, uTurnUsd: 0.11 });
    expect(() => turnPolicy({ ...base, limits: { model: 2, paidTools: 0, freeTools: 1, decisions: 0 },
      otherModelCalls: [{ upperUsd: '0.01', multiplier: '2' }] })).toThrow('TURN_POLICY_INVALID');
  });
});
