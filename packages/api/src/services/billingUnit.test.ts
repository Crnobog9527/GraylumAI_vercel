/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  billingUnitSettingsFromRows,
  buildMultiplierSnapshot,
  multiplierForCall,
  parseCreditsPerUsd,
  parseMultiplier,
  parseOptionalMultiplier,
  readBillingUnitSettings,
  readMultiplierSnapshot,
  resolveModelMultiplier,
} from './billingUnit';

type Result = { data: unknown; error: unknown };

function fakeDb(tables: Record<string, Result>) {
  const queries: Array<{ table: string; columns: string; ids: unknown[] }> = [];
  const db = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            in(_column: string, ids: unknown[]) {
              queries.push({ table, columns, ids });
              return Promise.resolve(tables[table] ?? { data: null, error: { code: 'missing' } });
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const Q = 'billing_credits_per_usd';
const M = 'billing_token_price_multiplier';

describe('multiplier and q validation', () => {
  it.each([['1', '1'], ['3', '3'], ['20', '20'], ['20.00', '20'], ['1.50', '1.5'], ['19.99', '19.99'], [3, '3'], [2.5, '2.5']])(
    'accepts %s as %s', (input, expected) => expect(parseMultiplier(input)).toBe(expected));

  it.each(['0', '0.99', '-1', '20.01', '21', '1.234', 'NaN', 'Infinity', '3e0', '03', '3.', '', ' 3', null, undefined, Number.NaN, {}, 0.1])(
    'rejects multiplier %s without rounding', (input) => expect(() => parseMultiplier(input)).toThrow('MULTIPLIER_INVALID'));

  it('NULL override inherits; other invalid values do not', () => {
    expect(parseOptionalMultiplier(null)).toBeNull();
    expect(() => parseOptionalMultiplier(undefined)).toThrow('MULTIPLIER_INVALID');
    expect(() => parseOptionalMultiplier('0')).toThrow('MULTIPLIER_INVALID');
  });

  it.each([['100', '100'], [1000, '1000'], ['100.50', '100.5'], ['0.5', '0.5']])('accepts q %s', (input, expected) =>
    expect(parseCreditsPerUsd(input)).toBe(expected));

  it.each(['0', '0.0', '-100', '1e3', 'abc', null, 0.1 + 0.2, '1000000000000'])('rejects q %s', (input) =>
    expect(() => parseCreditsPerUsd(input)).toThrow('SETTINGS_INVALID'));
});

describe('billing unit settings read', () => {
  it('uses 100 / 3 only when the keys are confirmed absent', () => {
    expect(billingUnitSettingsFromRows([])).toEqual({
      creditsPerUsd: '100', defaultMultiplier: '3', source: { creditsPerUsd: 'default', defaultMultiplier: 'default' },
    });
  });

  it('keeps configured values, including an old q=1000 contract value', () => {
    expect(billingUnitSettingsFromRows([{ key: Q, value: 1000 }, { key: M, value: '1.5' }])).toMatchObject({
      creditsPerUsd: '1000', defaultMultiplier: '1.5', source: { creditsPerUsd: 'configured', defaultMultiplier: 'configured' },
    });
  });

  it.each([
    [[{ key: Q, value: null }]],
    [[{ key: M, value: null }]],
    [[{ key: M, value: '0' }]],
    [[{ key: M, value: '25' }]],
    [[{ key: Q, value: 'abc' }]],
    [[{ key: Q, value: 100 }, { key: Q, value: 100 }]],
  ])('rejects explicit NULL, invalid or duplicate global values %j', (rows) =>
    expect(() => billingUnitSettingsFromRows(rows)).toThrow('SETTINGS_INVALID'));

  it('a read error rejects instead of falling back', async () => {
    const { db } = fakeDb({ system_settings: { data: null, error: { code: 'PGRST' } } });
    await expect(readBillingUnitSettings(db)).rejects.toThrow('SETTINGS_UNAVAILABLE');
  });
});

describe('per-model multiplier snapshot', () => {
  const settingsOk = { data: [{ key: Q, value: 100 }, { key: M, value: 3 }], error: null };

  it('model override wins, NULL inherits the site default, and they never multiply', () => {
    expect(resolveModelMultiplier({ price_multiplier: null }, '3')).toEqual({ multiplier: '3', source: 'global' });
    expect(resolveModelMultiplier({ price_multiplier: 2 }, '3')).toEqual({ multiplier: '2', source: 'model' });
    expect(() => resolveModelMultiplier({}, '3')).toThrow('MODEL_UNAVAILABLE');
    expect(() => resolveModelMultiplier({ price_multiplier: 0 }, '3')).toThrow('MULTIPLIER_INVALID');
  });

  it('freezes q, the default and each approved model; later lookups only use the frozen map', async () => {
    const { db, queries } = fakeDb({
      system_settings: settingsOk,
      ai_models: { data: [{ id: 'a', price_multiplier: null }, { id: 'b', price_multiplier: '2.5' }], error: null },
    });
    const snapshot = await readMultiplierSnapshot(db, ['b', 'a', 'a']);
    expect(queries.map((query) => query.table)).toEqual(['system_settings', 'ai_models']);
    expect(snapshot.models).toEqual({ a: { multiplier: '3', source: 'global' }, b: { multiplier: '2.5', source: 'model' } });
    expect(multiplierForCall(snapshot, 'b')).toEqual({ multiplier: '2.5', source: 'model', snapshotHash: snapshot.hash });
    expect(() => multiplierForCall(snapshot, 'c')).toThrow('MODEL_NOT_APPROVED');
    expect(() => multiplierForCall({ ...snapshot, models: { ...snapshot.models, a: { multiplier: '9', source: 'model' } } }, 'a'))
      .toThrow('SNAPSHOT_INVALID');
  });

  it('hash is order independent and changes with any frozen value', () => {
    const settings = { creditsPerUsd: '100', defaultMultiplier: '3' };
    const one = buildMultiplierSnapshot(settings, { a: { multiplier: '3', source: 'global' }, b: { multiplier: '2', source: 'model' } });
    const two = buildMultiplierSnapshot(settings, { b: { multiplier: '2', source: 'model' }, a: { multiplier: '3', source: 'global' } });
    expect(one.hash).toBe(two.hash);
    expect(buildMultiplierSnapshot({ ...settings, creditsPerUsd: '1000' }, one.models).hash).not.toBe(one.hash);
  });

  it.each([
    [{ data: null, error: { code: '42703' } }, 'MODEL_UNAVAILABLE'],
    [{ data: [{ id: 'a' }], error: null }, 'MODEL_UNAVAILABLE'],
    [{ data: [], error: null }, 'MODEL_MISSING'],
    [{ data: [{ id: 'a', price_multiplier: '25' }], error: null }, 'MULTIPLIER_INVALID'],
  ])('rejects undeployed column, missing row or invalid override %#', async (models, code) => {
    const { db } = fakeDb({ system_settings: settingsOk, ai_models: models });
    await expect(readMultiplierSnapshot(db, ['a'])).rejects.toThrow(code);
  });

  it('bounds the approved model set', async () => {
    const { db } = fakeDb({ system_settings: settingsOk });
    await expect(readMultiplierSnapshot(db, [])).rejects.toThrow('SNAPSHOT_INVALID');
    await expect(readMultiplierSnapshot(db, Array.from({ length: 17 }, (_, i) => `m${i}`))).rejects.toThrow('SNAPSHOT_INVALID');
  });
});
