import { describe, expect, it } from 'vitest';

import { spendCapUsd } from './config';
import { dbSpendReader, SpendCapExceeded, SpendMeter, type SpendStore } from './spend';

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

describe('the cap holds across tests and restarts', () => {
  const memoryStore = () => { let saved: unknown = null; return { load: async () => saved, save: async (state: unknown) => { saved = JSON.parse(JSON.stringify(state)); } } as SpendStore; };

  it('refuses to start a later test once the cap has been passed, also in a new worker', async () => {
    const store = memoryStore();
    const first = new SpendMeter(0.5, sequence(0.6), store);
    await expect(first.checkpoint('turn')).rejects.toBeInstanceOf(SpendCapExceeded);
    const restarted = new SpendMeter(0.5, sequence(0), store);
    await expect(restarted.assertRoom('next test')).rejects.toThrow(/cap already passed/);
  });

  it('lets a test start while there is room, and stops it when the total is already over', async () => {
    await expect(new SpendMeter(0.5, sequence(0.1), memoryStore()).assertRoom('t')).resolves.toBeUndefined();
    await expect(new SpendMeter(0.5, sequence(0.7), memoryStore()).assertRoom('t')).rejects.toBeInstanceOf(SpendCapExceeded);
  });

  it('keeps the journeys it recorded, so the report survives a worker restart', async () => {
    const store = memoryStore();
    await new SpendMeter(0.5, sequence(0.1), store).finishJourney('a');
    const next = new SpendMeter(0.5, sequence(0.25), store);
    await next.finishJourney('b');
    expect(next.journeys.map(entry => entry.label)).toEqual(['a', 'b']);
    expect(next.totalUsd).toBeCloseTo(0.25);
  });

  it('never reports zero for an unknown account', () => {
    expect(() => dbSpendReader({} as never, [], '2026-01-01T00:00:00Z')).toThrow(/No billing account/);
  });
});
