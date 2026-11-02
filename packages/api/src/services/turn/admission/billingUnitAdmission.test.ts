/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWindowMultipliers, callBillingUnit, freezeWindowBillingUnit, frozenBillingUnit } from './billingUnitAdmission';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function db(settings: unknown[], models: unknown[], error: unknown = null) {
  return { from: (table: string) => ({ select: () => ({ in: async () => (
    error ? { data: null, error } : { data: table === 'system_settings' ? settings : models, error: null }) }) }) } as unknown as SupabaseClient;
}
const settings = [{ key: 'billing_credits_per_usd', value: '1000' }, { key: 'billing_token_price_multiplier', value: '1' }];
const window = (policies: Array<{ modelId: string; multiplier?: string }>, multiplier = '3') =>
  ({ creditsPerUsd: '1000', multiplier, callPolicies: policies });

describe('window multiplier shape', () => {
  it('accepts an old window without multipliers and a new one where every entry has one up to the window m', () => {
    expect(() => assertWindowMultipliers(window([{ modelId: A }, { modelId: B }]))).not.toThrow();
    expect(() => assertWindowMultipliers(window([{ modelId: A, multiplier: '2' }, { modelId: B, multiplier: '3' }]))).not.toThrow();
  });
  it.each([
    [[{ modelId: A, multiplier: '2' }, { modelId: B }]],
    [[{ modelId: A, multiplier: '3.5' }]],
    [[{ modelId: A, multiplier: '0' }]],
    [[{ modelId: A, multiplier: '1.234' }]],
  ])('rejects mixed, above-window or invalid entries %#', (policies) => {
    expect(() => assertWindowMultipliers(window(policies))).toThrow('RUNTIME_STAGING_POLICY_INVALID');
  });
});

describe('freezing the window against the configuration', () => {
  const models = [{ id: A, price_multiplier: null }, { id: B, price_multiplier: '3' }];

  it('freezes q and each selected m_i when the window equals the configuration', async () => {
    const snapshot = await freezeWindowBillingUnit(db(settings, models), window([{ modelId: A, multiplier: '1' }, { modelId: B, multiplier: '3' }]),
      [{ modelId: A, multiplier: '1' }, { modelId: B, multiplier: '3' }]);
    expect(frozenBillingUnit.parse(snapshot)).toMatchObject({
      creditsPerUsd: '1000', models: { [A]: { multiplier: '1', source: 'global' }, [B]: { multiplier: '3', source: 'model' } },
    });
  });

  it('an old window without multipliers cannot admit new runs', async () => {
    await expect(freezeWindowBillingUnit(db(settings, models), window([{ modelId: A }]), [{ modelId: A }]))
      .rejects.toThrow('RUNTIME_BILLING_UNIT_WINDOW_OUTDATED');
  });

  it.each([
    ['a different q', [{ key: 'billing_credits_per_usd', value: '100' }, settings[1]], [{ modelId: A, multiplier: '1' }]],
    ['a different model m', settings, [{ modelId: B, multiplier: '2' }]],
    ['a different inherited m', settings, [{ modelId: A, multiplier: '1.5' }]],
  ])('refuses %s between the window and the configuration', async (_label, rows, selected) => {
    await expect(freezeWindowBillingUnit(db(rows, models), window(selected), selected)).rejects.toThrow('RUNTIME_BILLING_UNIT_MISMATCH');
  });

  it('a configuration that cannot be read refuses instead of using the window as the rate source', async () => {
    await expect(freezeWindowBillingUnit(db(settings, models, { code: 'x' }), window([{ modelId: A, multiplier: '1' }]),
      [{ modelId: A, multiplier: '1' }])).rejects.toThrow('RUNTIME_BILLING_UNIT_UNAVAILABLE');
  });
});

describe('per-call copy', () => {
  const rules = { billingUnit: { version: 'bill-unit-v2' as const, creditsPerUsd: '1000', defaultMultiplier: '1',
    models: { [A]: { multiplier: '2', source: 'model' as const } }, providers: {}, hash: 'f'.repeat(64) } };
  it('copies the policy multiplier with its frozen source; old contracts add nothing', () => {
    expect(callBillingUnit(rules, { modelId: A, multiplier: '2' })).toEqual({ billingUnit: { modelId: A, multiplier: '2', source: 'model' } });
    expect(callBillingUnit({}, { modelId: A, multiplier: '2' })).toEqual({});
    expect(callBillingUnit(rules, { modelId: A })).toEqual({});
    expect(() => callBillingUnit(rules, { modelId: B, multiplier: '2' })).toThrow('BILL2_UNIT_MULTIPLIER_INVALID');
  });
});
