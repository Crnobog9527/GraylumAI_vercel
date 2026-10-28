import { describe, expect, it } from 'vitest';

import { spendCapUsd } from './config';
import { SpendCapExceeded, SpendMeter } from './spend';

const sequence = (...values: number[]) => { let i = 0; return async () => values[Math.min(i++, values.length - 1)]!; };

describe('SpendMeter', () => {
  it('records what each journey added and totals them', async () => {
    const meter = new SpendMeter(0.5, sequence(0.1, 0.25, 0.3));
    expect((await meter.finishJourney('a')).usd).toBeCloseTo(0.1);
    expect((await meter.finishJourney('b')).usd).toBeCloseTo(0.15);
    expect((await meter.finishJourney('c')).usd).toBeCloseTo(0.05);
    expect(meter.totalUsd).toBeCloseTo(0.3);
  });

  it('stops the run as soon as the cumulative cost passes the cap, and records the journey that did it', async () => {
    const meter = new SpendMeter(0.5, sequence(0.2, 0.51));
    await meter.checkpoint('turn 1');
    await expect(meter.checkpoint('turn 2')).rejects.toBeInstanceOf(SpendCapExceeded);
    expect(meter.journeys.at(-1)).toMatchObject({ label: 'turn 2', cumulativeUsd: 0.51 });
  });

  it('allows exactly the cap and refuses a cent over', async () => {
    await expect(new SpendMeter(0.5, sequence(0.5)).checkpoint('x')).resolves.toBe(0.5);
    await expect(new SpendMeter(0.5, sequence(0.5001)).finishJourney('x')).rejects.toBeInstanceOf(SpendCapExceeded);
  });
});

describe('spendCapUsd', () => {
  it('defaults to the approved 0.5 and can only be lowered', () => {
    expect(spendCapUsd({})).toBe(0.5);
    expect(spendCapUsd({ CORE_E2E_MAX_USD: '0.2' })).toBe(0.2);
    expect(() => spendCapUsd({ CORE_E2E_MAX_USD: '0.6' })).toThrow();
    expect(() => spendCapUsd({ CORE_E2E_MAX_USD: '0' })).toThrow();
    expect(() => spendCapUsd({ CORE_E2E_MAX_USD: 'abc' })).toThrow();
  });
});
