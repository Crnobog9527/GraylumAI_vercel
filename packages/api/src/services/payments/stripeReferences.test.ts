/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { findStripeReference, resolveStripeOrderIds } from './stripeReferences';

type Row = Record<string, unknown>;
function database(rows: Row[], error: unknown = null) {
  const from = vi.fn(() => {
    const filters: Array<[string, unknown]> = [];
    let cap = Infinity;
    const result = () => ({ error, data: rows.filter(row => filters.every(([key, value]) => row[key] === value)).slice(0, cap) });
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      limit: (value: number) => { cap = value; return query; },
      maybeSingle: async () => {
        const selected = result();
        return { data: selected.data.length === 1 ? selected.data[0] : null,
          error: error ?? (selected.data.length > 1 ? { code: 'PGRST116' } : null) };
      },
      then: <T>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
    };
    return query;
  });
  return { from } as unknown as Parameters<typeof findStripeReference>[0];
}
const scope = { merchant: 'acct_fixture', mode: 'test' as const };
const common = { channel: 'stripe', merchant_namespace: scope.merchant, mode: scope.mode };
const order = { id: 'fixture-order', payment_channel: 'stripe', merchant_namespace: scope.merchant,
  payment_mode: 'test', price_ref_id: 'fixture-price-ref', subscription_id: 'fixture-subscription' };
const refs: Row[] = [
  { ...common, id: 'fixture-price-ref', object_type: 'price', external_id: 'price_original' },
  { ...common, object_type: 'checkout', order_id: order.id, external_id: 'cs_original' },
  { ...common, object_type: 'invoice', order_id: order.id, external_id: 'in_original' },
  { ...common, object_type: 'subscription', subscription_id: order.subscription_id, external_id: 'sub_original' },
];
describe('Stripe external identity authority', () => {
  it('ignores divergent old columns and unrelated merchant or live mappings', async () => {
    const db = database([...refs, ...refs.map(row => ({ ...row, mode: 'live', external_id: 'wrong' })),
      ...refs.map(row => ({ ...row, merchant_namespace: 'acct_other', external_id: 'wrong' }))]);
    await expect(resolveStripeOrderIds(db, { ...order, stripe_invoice_id: 'in_stale' })).resolves.toMatchObject({
      stripe_price_id: 'price_original', stripe_checkout_session_id: 'cs_original',
      stripe_invoice_id: 'in_original', stripe_subscription_id: 'sub_original',
    });
  });
  it('permits a missing optional checkout while retaining mandatory price authority', async () => {
    await expect(resolveStripeOrderIds(database(refs.filter(row => row.object_type !== 'checkout')), order))
      .resolves.toMatchObject({ stripe_checkout_session_id: null });
    await expect(resolveStripeOrderIds(database(refs.filter(row => row.object_type !== 'price')), order))
      .rejects.toThrow('PAY_COMMON_PRICE_MAPPING_MISSING');
  });
  it.each(['checkout', 'invoice'])('rejects duplicate %s mappings', async kind => {
    await expect(resolveStripeOrderIds(database([...refs, { ...refs.find(row => row.object_type === kind), external_id: 'duplicate' }]), order))
      .rejects.toThrow('PAY_COMMON_MAPPING_AMBIGUOUS');
  });
  it.each([{ subscriptions: [] }, { subscriptions: [refs[3], { ...refs[3], external_id: 'sub_duplicate' }] }])('rejects missing or duplicate subscription mappings', async ({ subscriptions }) => {
    await expect(resolveStripeOrderIds(database([...refs.slice(0, 3), ...subscriptions]), order))
      .rejects.toThrow('PAY_COMMON_SUBSCRIPTION_MAPPING_MISSING');
  });
  it('rejects unknown order identity and mapping read failures', async () => {
    await expect(resolveStripeOrderIds(database(refs), { ...order, payment_channel: 'unknown' }))
      .rejects.toThrow('PAY_COMMON_ORDER_IDENTITY_UNKNOWN');
    await expect(resolveStripeOrderIds(database(refs, { code: '42501' }), order))
      .rejects.toThrow('PAY_COMMON_MAPPING_READ_FAILED');
  });
  it('resolves one scoped external identity and never guesses through ambiguity', async () => {
    const invoice = refs[2];
    const db = database([invoice, { ...invoice, merchant_namespace: 'acct_other' }]);
    await expect(findStripeReference(db, 'invoice', 'in_original', scope)).resolves.toMatchObject({ order_id: order.id });
    await expect(findStripeReference(db, 'invoice', 'in_original')).rejects.toThrow('PAY_COMMON_MAPPING_AMBIGUOUS');
    await expect(findStripeReference(db, 'invoice', 'in_missing', scope)).resolves.toBeUndefined();
  });
});
