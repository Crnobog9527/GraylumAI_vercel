/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { aggregateCredits } from './decimal';
import {
  formatWeightedUsd,
  parseWeightedUsd,
  weightedAggregateCredits,
  weightedCreditsFromUnits,
  weightedDeltaCredits,
  weightedUsdUnits,
} from './weighted';

describe('BILL-UNIT weighted arithmetic', () => {
  it('rounds once over Σ(cost × m_i), not per call and not with one shared multiplier', () => {
    const mixed = [{ costUsd: '0.002', multiplier: '2' }, { costUsd: '0.002', multiplier: '3' }];
    expect(weightedAggregateCredits(mixed, '100')).toBe(1);
    const perCall = mixed.reduce((sum, entry) => sum + weightedAggregateCredits([entry], '100'), 0);
    expect(perCall).toBe(2);
    expect(aggregateCredits(['0.002', '0.002'], '100', '3')).toBe(2);
  });

  it('matches the plan examples at q=100, m=3', () => {
    expect(weightedAggregateCredits([{ costUsd: '0.02', multiplier: '3' }], '100')).toBe(6);
    expect(weightedAggregateCredits([{ costUsd: '0.178304', multiplier: '3' }], '100')).toBe(54);
    expect(weightedAggregateCredits([{ costUsd: '0.066864', multiplier: '3' }], '100')).toBe(21);
    const tiny = Array.from({ length: 3 }, () => ({ costUsd: '0.001', multiplier: '3' }));
    expect(weightedAggregateCredits(tiny, '100')).toBe(1);
    expect(weightedAggregateCredits([{ costUsd: '0.0076', multiplier: '3' }], '100')).toBe(3);
  });

  it('keeps the old single-multiplier contract result when every m_i equals it', () => {
    const costs = ['0.0004', '0.0004', '0.123456789012'];
    expect(weightedAggregateCredits(costs.map((costUsd) => ({ costUsd, multiplier: '1.5' })), '1000'))
      .toBe(aggregateCredits(costs, '1000', '1.5'));
  });

  it('cumulative deltas sum to the single rounded total (1/0/0 for three tiny mixed calls)', () => {
    const calls = [
      { costUsd: '0.001', multiplier: '1' },
      { costUsd: '0.001', multiplier: '2' },
      { costUsd: '0.001', multiplier: '3' },
    ];
    let units = 0n;
    const deltas = calls.map((call) => {
      const step = weightedDeltaCredits(units, call, '100');
      units = step.units;
      return step.delta;
    });
    expect(deltas).toEqual([1, 0, 0]);
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(weightedAggregateCredits(calls, '100'));
  });

  it('keeps 12-decimal costs times 2-decimal multipliers exact through q', () => {
    const units = weightedUsdUnits([{ costUsd: '0.000000000001', multiplier: '19.99' }]);
    expect(formatWeightedUsd(units)).toBe('0.00000000001999');
    expect(parseWeightedUsd(formatWeightedUsd(units))).toBe(units);
    expect(weightedCreditsFromUnits(units, '100')).toBe(1);
    expect(weightedCreditsFromUnits(0n, '100')).toBe(0);
    expect(weightedAggregateCredits([{ costUsd: '0.01', multiplier: '1' }], '100.5')).toBe(2);
  });

  it('rejects zero rules, invalid text and overflow', () => {
    expect(() => weightedAggregateCredits([{ costUsd: '1', multiplier: '0' }], '100')).toThrow('RULES');
    expect(() => weightedAggregateCredits([{ costUsd: '1', multiplier: '3' }], '0')).toThrow('RULES');
    expect(() => weightedAggregateCredits([{ costUsd: '1', multiplier: '3e0' }], '100')).toThrow('DECIMAL');
    expect(() => weightedAggregateCredits([{ costUsd: '999999999999', multiplier: '20' }], '1000')).toThrow('OVERFLOW');
    expect(() => parseWeightedUsd('1.0000000000000000000000001')).toThrow('DECIMAL');
    expect(() => formatWeightedUsd(-1n)).toThrow('DECIMAL');
  });
});
