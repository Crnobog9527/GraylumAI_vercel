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
    await expect(save()).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('更新对应的 Stripe 价格') });
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
  it('shows the same safe admin correction when SQL rejects price evidence against stored catalog terms', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'PAY_COMMON_PRICE_MISMATCH', details: 'private database detail' } });
    await expect(save()).rejects.toMatchObject({ code: 'BAD_REQUEST',
      message: '修改金额时请同时更新对应的 Stripe 价格，或清除该价格以暂停购买。' });
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });
  it.each([
    ['credit_package', 'one_time', { price: 2999 }],
    ['membership_plan', 'monthly', { monthly_price: 2999 }],
    ['membership_plan', 'yearly', { yearly_price: 29999 }],
  ] as const)('rejects a changed amount with the old provider price before dispatching the %s catalog write', async (kind, cycle, values) => {
    const original = await mocks.retrieve();
    mocks.retrieve.mockResolvedValue({ ...original,
      type: cycle === 'one_time' ? 'one_time' : 'recurring',
      recurring: cycle === 'one_time' ? null : { ...original.recurring, interval: cycle === 'yearly' ? 'year' : 'month' } });
    await expect(saveStripeCatalog({ db: { rpc: mocks.rpc }, id: 'fixture_product', kind, values,
      prices: { [cycle]: 'price_fixture' } })).rejects.toMatchObject({ code: 'BAD_REQUEST',
      message: '修改金额时请同时更新对应的 Stripe 价格，或清除该价格以暂停购买。' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('keeps provider transport details private instead of converting them to editable price errors', async () => {
    mocks.retrieve.mockRejectedValue(new Error('private provider detail'));
    await expect(save()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '支付价格暂时无法验证，请稍后重试' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('leaves other SQL rejections to the existing caller error boundary', async () => {
    const rejected = { data: null, error: { message: 'PAY_COMMON_PRODUCT_UNAVAILABLE' } };
    mocks.rpc.mockResolvedValue(rejected);
    await expect(save()).resolves.toEqual(rejected);
  });
  it.each([
    ['credit_package', { price: 2999 }],
    ['membership_plan', { monthly_price: 2999 }],
    ['membership_plan', { yearly_price: 29999 }],
  ] as const)('rejects amount-only updates rejected atomically for %s', async (kind, values) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'PAY_COMMON_PRICE_REPLACEMENT_REQUIRED', code: '23514' } });
    await expect(saveStripeCatalog({ db: { rpc: mocks.rpc }, id: 'fixture_product', kind, values, prices: {} }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Stripe') });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('pay_common_save_catalog', expect.objectContaining({
      p_values: values, p_prices: {},
    }));
  });
  it('allows an explicitly cleared price with a changed amount in one transaction', async () => {
    await saveStripeCatalog({ db: { rpc: mocks.rpc }, id: 'fixture_product', kind: 'credit_package',
      values: { price: 2999 }, prices: { one_time: null } });
    expect(mocks.rpc).toHaveBeenCalledWith('pay_common_save_catalog', expect.objectContaining({
      p_values: { price: 2999 }, p_prices: { one_time: null },
    }));
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it('keeps standard catalog prices separate from current promotional offers', async () => {
    const rows = ['standard', 'gold_first30', 'founder'].map(offer => ({
      channel: 'stripe', merchant_namespace: 'acct_fixture', mode: 'test', object_type: 'price',
      offer_kind: offer, is_current: true, membership_plan_id: 'fixture_plan',
      billing_cycle: 'monthly', external_id: `price_${offer}`,
    }));
    let selected = rows;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        selected = selected.filter(row => row[key as keyof typeof row] === value); return query;
      },
      in: async () => ({ data: selected, error: null }),
    };
    const prices = await loadCurrentStripePrices({
      db: { from: () => query } as unknown as Parameters<typeof loadCurrentStripePrices>[0]['db'],
      kind: 'membership_plan', scope: { merchant: 'acct_fixture', mode: 'test' }, ids: ['fixture_plan'],
    });
    expect([...prices]).toEqual([['fixture_plan:monthly', 'price_standard']]);
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
