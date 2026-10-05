/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeServiceUnavailableError } from '../../lib/publicError';
import { getStripeClient } from '../stripe';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import type { StripeScope } from './purchaseFacts';

type Cycle = 'monthly' | 'yearly' | 'one_time';
const priceReplacementRequired = () => new TRPCError({
  code: 'BAD_REQUEST', message: '修改金额时请同时更新对应的 Stripe 价格，或清除该价格以暂停购买。',
});
export async function saveStripeCatalog(input: {
  db: Pick<SupabaseClient, 'rpc'>;
  kind: 'credit_package' | 'membership_plan';
  id?: string;
  values: Record<string, unknown>;
  prices: Partial<Record<Cycle, string | null | undefined>>;
  expectedLevel?: string;
}) {
  const entries = Object.entries(input.prices).filter(([, value]) => value !== undefined)
    .map(([cycle, value]) => [cycle, value === '' ? null : value] as const);
  let scope: StripeScope | null = null;
  const prices: Record<string, unknown> = {};
  if (entries.length) {
    const stripe = getStripeClient();
    scope = await resolveStripeScope(stripe).catch(error => {
      throw createSafeServiceUnavailableError(error, '支付价格暂时无法验证，请稍后重试');
    });
    for (const [cycle, id] of entries) {
      if (id === null) { prices[cycle] = null; continue; }
      const price = await stripe.prices.retrieve(id!).catch(error => {
        throw createSafeServiceUnavailableError(error, '支付价格暂时无法验证，请稍后重试');
      });
      const amountField = cycle === 'one_time' ? 'price' : `${cycle}_price`;
      const requestedAmount = input.values[amountField];
      if (price.id !== id || price.object !== 'price' || !price.active || price.currency !== 'usd'
        || price.livemode !== (scope.mode === 'live') || !Number.isSafeInteger(price.unit_amount)
        || (typeof requestedAmount === 'number' && price.unit_amount !== requestedAmount)
        || price.billing_scheme !== 'per_unit' || price.custom_unit_amount || price.transform_quantity || price.tiers_mode
        || (price.tax_behavior ?? 'unspecified') !== 'unspecified'
        || (cycle === 'one_time' ? price.type !== 'one_time' || price.recurring !== null
          : price.type !== 'recurring' || price.recurring?.interval !== (cycle === 'yearly' ? 'year' : 'month')
            || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed')) {
        throw priceReplacementRequired();
      }
      prices[cycle] = { external_id: id, unit_amount: price.unit_amount,
        currency: price.currency, mode: scope.mode, billing_cycle: cycle };
    }
  }
  const result = await input.db.rpc('pay_common_save_catalog', {
    p_kind: input.kind, p_id: input.id ?? null, p_values: input.values, p_prices: prices,
    p_merchant_namespace: scope?.merchant ?? null, p_payment_mode: scope?.mode ?? null,
    p_expected_level: input.expectedLevel ?? null,
  });
  if (result.error?.message === 'PAY_COMMON_PRICE_REPLACEMENT_REQUIRED'
    || result.error?.message === 'PAY_COMMON_PRICE_MISMATCH') {
    throw priceReplacementRequired();
  }
  return result;
}

export async function loadCurrentStripePrices(input: {
  db: Pick<SupabaseClient, 'from'>;
  scope: StripeScope;
  kind: 'credit_package' | 'membership_plan';
  ids: string[];
}) {
  const refs = new Map<string, string>();
  if (!input.ids.length) return refs;
  const column = input.kind === 'credit_package' ? 'credit_package_id' : 'membership_plan_id';
  const result = await input.db.from('payment_provider_refs').select('external_id, credit_package_id, membership_plan_id, billing_cycle')
    .eq('channel', 'stripe').eq('merchant_namespace', input.scope.merchant).eq('mode', input.scope.mode)
    .eq('object_type', 'price').eq('is_current', true).in(column, input.ids);
  if (result.error || !Array.isArray(result.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED', { cause: result.error });
  for (const ref of result.data) {
    const key = `${ref[column]}:${ref.billing_cycle}`;
    if (refs.has(key)) throw new Error('PAY_COMMON_PRICE_MAPPING_AMBIGUOUS');
    refs.set(key, ref.external_id);
  }
  return refs;
}

export async function loadConfiguredStripePrices(input: Omit<Parameters<typeof loadCurrentStripePrices>[0], 'scope'> & { testOnly?: boolean }) {
  try {
    const scope = await resolveStripeScope(getStripeClient());
    if (input.testOnly && scope.mode !== 'test') return new Map<string, string>();
    return await loadCurrentStripePrices({ ...input, scope });
  } catch (error) {
    throw createSafeServiceUnavailableError(error, '支付价格暂时无法读取，请稍后重试');
  }
}

// Admin forms keep their existing field names; historical derived columns are not an authority.
export async function hydrateStripeCatalogPrices<T extends { id: string }>(input: {
  db: Pick<SupabaseClient, 'from'>;
  kind: 'credit_package' | 'membership_plan';
  rows: T[];
}) {
  if (!input.rows.length) return input.rows;
  const prices = await loadConfiguredStripePrices({ ...input, ids: input.rows.map(row => row.id) });
  return input.rows.map(row => input.kind === 'credit_package'
    ? { ...row, stripe_price_id: prices.get(`${row.id}:one_time`) ?? null }
    : { ...row, stripe_monthly_price_id: prices.get(`${row.id}:monthly`) ?? null,
      stripe_yearly_price_id: prices.get(`${row.id}:yearly`) ?? null });
}
