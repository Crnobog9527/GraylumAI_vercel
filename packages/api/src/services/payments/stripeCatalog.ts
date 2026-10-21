/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeServiceUnavailableError } from '../../lib/publicError';
import { getStripeClient, isStripeCheckoutConfigured } from '../stripe';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import type { StripeScope } from './purchaseFacts';
import { getWaffoOperationsClient } from './waffoTestOperationsClient';
import { readPaymentMethodRoutes, newPurchaseChannel } from './methodRouting';
import { paymentDeploymentMode } from './methodCheckoutGate';

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
    .eq('object_type', 'price').eq('offer_kind', 'standard').eq('is_current', true)
    // The admin catalog manages recurring plan and pack prices; wallet one-time membership prices (0221) are separate.
    .eq('price_usage', input.kind === 'credit_package' ? 'package' : 'subscription')
    // It also manages only the generic pack price: Pro/Gold member pack prices (0211 tiers) belong to method checkout.
    .eq('package_tier', 'legacy').in(column, input.ids);
  if (result.error || !Array.isArray(result.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED', { cause: result.error });
  for (const ref of result.data) {
    const key = `${ref[column]}:${ref.billing_cycle}`;
    if (refs.has(key)) throw new Error('PAY_COMMON_PRICE_MAPPING_AMBIGUOUS');
    refs.set(key, ref.external_id);
  }
  return refs;
}

export async function loadConfiguredStripePrices(input: Omit<Parameters<typeof loadCurrentStripePrices>[0], 'scope'>) {
  try {
    const scope = await resolveStripeScope(getStripeClient());
    return await loadCurrentStripePrices({ ...input, scope });
  } catch (error) {
    throw createSafeServiceUnavailableError(error, '支付价格暂时无法读取，请稍后重试');
  }
}

/** The only packs 0222 card checkout sells, as (price cents, credits, bonus); anything else is PAY_WAFFO_CATALOG_NOT_READY. */
const SELLABLE_MEMBER_PACKS = new Set(['990:990:0', '2990:2990:0', '9990:9990:1000']);
export function isSellableMemberPack(pack: { price: number; credits_amount: number; bonus_credits?: number | null }) {
  return SELLABLE_MEMBER_PACKS.has(`${pack.price}:${pack.credits_amount}:${pack.bonus_credits ?? 0}`);
}

/**
 * Pro/Gold pack prices (0211 tiers) that card checkout charges: 0222 admission picks exactly one current
 * `package` price of the buyer's tier in the connected account. Key `${packageId}:${tier}` → chargeable.
 * Two current prices for one tier make admission refuse, so they count as not chargeable. In the connected account's
 * own mode (R7: live in production), like method checkout; display only, the admission still decides.
 */
export async function loadMemberPackReadiness(input: { db: Pick<SupabaseClient, 'from'>; ids: string[]; channel?: 'stripe' | 'waffo' }) {
  const ready = new Map<string, boolean>();
  if (!input.ids.length) return ready;
  const channel = input.channel ?? 'stripe';
  const scope = channel === 'waffo' ? getWaffoOperationsClient(paymentDeploymentMode())
    : await resolveStripeScope(getStripeClient());
  const result = await input.db.from('payment_provider_refs').select('external_id, credit_package_id, package_tier')
    .eq('channel', channel).eq('merchant_namespace', scope.merchant).eq('mode', scope.mode)
    .eq('object_type', 'price').eq('offer_kind', 'standard').eq('is_current', true)
    .eq('price_usage', 'package').eq('billing_cycle', 'one_time')
    .in('package_tier', ['pro', 'gold']).in('credit_package_id', input.ids);
  if (result.error || !Array.isArray(result.data)) throw new Error('PAY_COMMON_MAPPING_READ_FAILED', { cause: result.error });
  for (const ref of result.data) {
    const key = `${ref.credit_package_id}:${ref.package_tier}`;
    ready.set(key, !ready.has(key) && typeof ref.external_id === 'string' && ref.external_id.trim() !== '');
  }
  return ready;
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

/** New-sale catalog availability follows the audited route, independent of the legacy global switch. */
export async function loadSelectedMemberPackReadiness(db: Pick<SupabaseClient, 'from'>, ids: string[]) {
  const channel = newPurchaseChannel(await readPaymentMethodRoutes(db));
  if (channel === 'stripe' && !isStripeCheckoutConfigured()) return new Map<string, boolean>();
  return loadMemberPackReadiness({ db, ids, channel });
}

/** Do not contact Stripe for the legacy catalog while emergency new sales use Waffo. */
export async function legacyStripeCatalogReady(db: Pick<SupabaseClient, 'from'>, legacyChannel?: string) {
  return legacyChannel === 'stripe' && isStripeCheckoutConfigured()
    && newPurchaseChannel(await readPaymentMethodRoutes(db)) === 'stripe';
}
