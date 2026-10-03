/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  ABSORB_ACK_KEY, ABSORB_CONFIG_KEY, acknowledgeAbsorb, absorbConfigSchema,
  calculateAbsorbAlerts, readAbsorbAlerts, saveAbsorbConfig, type AbsorbRow,
} from './bill2PlatformAlerts';
import type { SupabaseClient } from '@supabase/supabase-js';
const now = new Date('2026-10-03T23:59:59Z');
const config = { defaultUsd: '1', models: {} };
const row = (overrides: Partial<AbsorbRow> = {}): AbsorbRow => ({ model: 'v/a', utc_date: '2026-10-03',
  credits_per_usd: '100', call_multiplier: '3', platform_cap_credits: '300', platform_bound_credits: '0', ...overrides });

function memoryDb(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  let rpcCalls = 0;
  let report: AbsorbRow[] = [];
  const db = {
    from() {
      let key = ''; let expected: unknown; let conditional = false;
      let write: { key?: string; value: unknown } | undefined; let mode = '';
      const execute = async () => {
        if (mode === 'insert' && values.has(write!.key!)) return { data: null, error: { code: '23505' } };
        const target = write?.key ?? key;
        if (conditional && JSON.stringify(values.get(target)) !== JSON.stringify(expected)) return { data: [], error: null };
        if (write) values.set(target, write.value);
        return { data: [{ key: target }], error: null };
      };
      const builder = {
        select() { return builder; },
        eq(column: string, value: string) {
          if (column === 'key') key = value;
          else { expected = JSON.parse(value); conditional = true; }
          return builder;
        },
        maybeSingle: async () => ({ data: values.has(key) ? { value: structuredClone(values.get(key)) } : null, error: null }),
        insert(value: { key: string; value: unknown }) { mode = 'insert'; write = value; return builder; },
        update(value: { value: unknown }) { mode = 'update'; write = value; return builder; },
        upsert(value: { key: string; value: unknown }) { write = value; return builder; },
        then(resolve: (value: unknown) => unknown) { return execute().then(resolve); },
      };
      return builder;
    },
    rpc: async () => { rpcCalls += 1; return { data: report, error: null }; },
  };
  return { db: db as unknown as SupabaseClient, values, calls: () => rpcCalls,
    setRows: (rows: AbsorbRow[]) => { report = rows; } };
}

describe('platform absorbed nominal equivalent alert', () => {
  it('strictly exceeds, sums wallets/runs and includes both absorption causes', () => {
    expect(calculateAbsorbAlerts([row()], config, {}, now)).toEqual([]);
    expect(calculateAbsorbAlerts([row(), row({ platform_cap_credits: '0', platform_bound_credits: '1' })], config, {}, now))
      .toMatchObject([{ nominalEquivalentUsd: '1.003333333333' }]);
  });
  it('uses frozen rates and exact comparison even when rounded display equals threshold', () => {
    const rows = [row({ credits_per_usd: '999999999999', call_multiplier: '20', platform_cap_credits: '1' })];
    expect(calculateAbsorbAlerts(rows, { defaultUsd: '0', models: {} }, {}, now)).toHaveLength(1);
    expect(calculateAbsorbAlerts([row({ platform_cap_credits: '1' })], { defaultUsd: '0.003333333333', models: {} }, {}, now))
      .toHaveLength(1);
  });
  it('uses seven UTC settlement dates, model override and monotonic acknowledgement', () => {
    const rows = ['2026-09-26', '2026-09-27', '2026-10-02', '2026-10-03', '2026-10-04']
      .map(utc_date => row({ utc_date, platform_cap_credits: '301' }));
    expect(calculateAbsorbAlerts(rows, config, {}, now).map(a => a.utcDate))
      .toEqual(['2026-10-03', '2026-10-02', '2026-09-27']);
    expect(calculateAbsorbAlerts(rows, config, { 'v/a': '2026-10-02' }, now).map(a => a.utcDate)).toEqual(['2026-10-03']);
    expect(calculateAbsorbAlerts(rows, { ...config, models: { 'v/a': '2' } }, {}, now)).toEqual([]);
  });
  it('missing settings means disabled, and does not read the report', async () => {
    const f = memoryDb();
    expect(await readAbsorbAlerts(f.db, now)).toEqual({ status: 'disabled', alerts: [] });
    expect(f.calls()).toBe(0);
  });
  it('reads current configuration each time and persists validated settings', async () => {
    const f = memoryDb(); f.setRows([row()]);
    expect(await saveAbsorbConfig(f.db, { ...config, defaultUsd: '0' })).toEqual({ ...config, defaultUsd: '0' });
    expect((await readAbsorbAlerts(f.db, now)).alerts).toHaveLength(1);
    await saveAbsorbConfig(f.db, config);
    expect((await readAbsorbAlerts(f.db, now)).alerts).toHaveLength(0);
  });
  it('invalid stored settings or evidence fail unavailable rather than falsely clear', async () => {
    const f = memoryDb({ [ABSORB_CONFIG_KEY]: {} });
    await expect(readAbsorbAlerts(f.db, now)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    f.values.set(ABSORB_CONFIG_KEY, config); f.setRows([row({ credits_per_usd: '0' })]);
    await expect(readAbsorbAlerts(f.db, now)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('merges concurrent first creation and existing updates, keeping the later date and retry idempotence', async () => {
    const f = memoryDb();
    await Promise.all(['v/a', 'v/b'].map(model => acknowledgeAbsorb(f.db, { model, utcDate: '2026-10-01' }, now)));
    await Promise.all([
      acknowledgeAbsorb(f.db, { model: 'v/a', utcDate: '2026-10-03' }, now),
      acknowledgeAbsorb(f.db, { model: 'v/a', utcDate: '2026-10-02' }, now),
      acknowledgeAbsorb(f.db, { model: 'v/b', utcDate: '2026-10-02' }, now),
    ]);
    expect(await acknowledgeAbsorb(f.db, { model: 'v/a', utcDate: '2026-10-03' }, now))
      .toEqual({ 'v/a': '2026-10-03', 'v/b': '2026-10-02' });
    expect(f.values.get(ABSORB_ACK_KEY)).toEqual({ 'v/a': '2026-10-03', 'v/b': '2026-10-02' });
  });
  it('does not suppress future alerts and rejects malformed/non-fixed configuration', async () => {
    const f = memoryDb();
    await expect(acknowledgeAbsorb(f.db, { model: 'v/a', utcDate: '2026-10-04' }, now))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    for (const defaultUsd of ['-1', '1e2', '1.0000000000001', 1]) {
      expect(absorbConfigSchema.safeParse({ ...config, defaultUsd }).success).toBe(false);
    }
  });
});
