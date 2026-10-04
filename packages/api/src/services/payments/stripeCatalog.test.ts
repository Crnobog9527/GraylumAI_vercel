/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('../stripe', () => ({ getStripeClient: () => ({ prices: { retrieve: mocks.retrieve } }) }));
vi.mock('./stripeCheckoutPersistence', () => ({ resolveStripeScope: mocks.scope }));
import { loadCurrentStripePrices, saveStripeCatalog } from './stripeCatalog';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.mockResolvedValue({ merchant: 'acct_fixture', mode: 'test' });
  mocks.rpc.mockResolvedValue({ data: { id: 'fixture_product' }, error: null });
  mocks.retrieve.mockResolvedValue({ id: 'price_fixture', object: 'price', active: true, currency: 'usd',
    livemode: false, unit_amount: 1999, billing_scheme: 'per_unit', tax_behavior: 'unspecified',
    type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
});
const save = () => saveStripeCatalog({ db: { rpc: mocks.rpc }, kind: 'membership_plan',
  values: { name: 'Fixture', monthly_price: 1999 }, prices: { monthly: 'price_fixture' } });

describe('Stripe catalog authority', () => {
  it('validates provider evidence before the single catalog/mapping transaction', async () => {
    await save();
    expect(mocks.retrieve.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.rpc).toHaveBeenCalledWith('pay_common_save_catalog', expect.objectContaining({
      p_prices: { monthly: { external_id: 'price_fixture', unit_amount: 1999,
        currency: 'usd', mode: 'test', billing_cycle: 'monthly' } }, p_merchant_namespace: 'acct_fixture',
    }));
  });
  it.each([{ livemode: true }, { currency: 'eur' }, { active: false }, { unit_amount: null },
    { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } },
    { recurring: { interval: 'month', interval_count: 2, usage_type: 'licensed' } },
    { tax_behavior: 'inclusive' }, { billing_scheme: 'tiered' }])('refuses unsupported provider evidence %j', async patch => {
    mocks.retrieve.mockResolvedValue({ ...await mocks.retrieve(), ...patch });
    await expect(save()).rejects.toThrow('PAY_COMMON_PRICE_MISMATCH');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not call Stripe when no price mapping changes', async () => {
    await saveStripeCatalog({ db: { rpc: mocks.rpc }, kind: 'credit_package',
      values: { name: 'Renamed' }, prices: {} });
    expect(mocks.scope).not.toHaveBeenCalled(); expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it('clears an empty form price through the same catalog transaction', async () => {
    await saveStripeCatalog({ db: { rpc: mocks.rpc }, kind: 'membership_plan', values: {}, prices: { monthly: '' } });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('pay_common_save_catalog', expect.objectContaining({ p_prices: { monthly: null } }));
  });
  it('propagates a transaction rejection instead of claiming a saved catalog', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'PAY_COMMON_PRICE_MISMATCH' } });
    await expect(save()).resolves.toEqual({ data: null, error: { message: 'PAY_COMMON_PRICE_MISMATCH' } });
  });
  it('returns no current mapping for a missing price and refuses ambiguous or unreadable maps', async () => {
    type Query = { select: () => Query; eq: () => Query; in: ReturnType<typeof vi.fn> };
    const query: Query = { select: () => query, eq: () => query, in: vi.fn() };
    const input: Parameters<typeof loadCurrentStripePrices>[0] = {
      db: { from: () => query } as unknown as Parameters<typeof loadCurrentStripePrices>[0]['db'], kind: 'membership_plan',
      scope: { merchant: 'acct_fixture', mode: 'test' }, ids: ['fixture_plan'] };
    query.in.mockResolvedValue({ data: [], error: null });
    expect((await loadCurrentStripePrices(input)).size).toBe(0);
    const ref = { membership_plan_id: 'fixture_plan', billing_cycle: 'monthly', external_id: 'price_fixture' };
    query.in.mockResolvedValue({ data: [ref, { ...ref, external_id: 'price_duplicate' }], error: null });
    await expect(loadCurrentStripePrices(input)).rejects.toThrow('PAY_COMMON_PRICE_MAPPING_AMBIGUOUS');
    query.in.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(loadCurrentStripePrices(input)).rejects.toThrow('PAY_COMMON_MAPPING_READ_FAILED');
  });
});
