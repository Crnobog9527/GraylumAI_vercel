/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { stripeTestClockStagingOpen } from './methodCheckoutGate';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import type { StripeScope } from './purchaseFacts';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';

type Env = Record<string, string | undefined>;
export const STRIPE_TEST_CLOCK_BINDING = Object.freeze({ projectId: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC',
  domain: 'auth-staging.graylum.com', databaseHost: 'gvcpmcunmfrbxuwimxfa.supabase.co',
  branch: 'staging', repo: 'Crnobog9527/GraylumAI_vercel' });
export type TestClockOrder = { id: string; user_id: string; payment_channel?: string; payment_mode?: string;
  merchant_namespace?: string; payment_method?: string; stripe_managed_payments?: boolean | null;
  purchase_membership_level?: string; billing_cycle?: string; item_type?: string;
  checkout_request?: { providerRequest?: { customer?: unknown } } | null };
export function stripeTestClockRuntimeOpen(env: Env = process.env) {
  if (!stripeTestClockStagingOpen(env) || env.V3_RUNTIME_STAGING_DATABASE_HOST !== STRIPE_TEST_CLOCK_BINDING.databaseHost) return false;
  try { return new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname === STRIPE_TEST_CLOCK_BINDING.databaseHost; }
  catch { return false; }
}
export function testClockCustomerForOrder(order: TestClockOrder, scope: StripeScope, env: Env = process.env) {
  if (!stripeTestClockRuntimeOpen(env) || scope.mode !== 'test' || order.payment_mode !== 'test'
    || order.payment_channel !== 'stripe' || order.merchant_namespace !== scope.merchant
    || order.payment_method !== 'card' || order.stripe_managed_payments !== true
    || order.purchase_membership_level !== 'pro' || order.billing_cycle !== 'monthly' || order.item_type !== 'membership_plan') return null;
  const customer = order.checkout_request?.providerRequest?.customer;
  return typeof customer === 'string' && /^cus_[A-Za-z0-9]{6,128}$/.test(customer) ? customer : null;
}
export async function readStripeTestClock(stripe: Stripe, customerId: string, userId: string) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted || customer.id !== customerId || customer.livemode !== false
    || customer.metadata?.graylum_user_id !== userId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const clockId = typeof customer.test_clock === 'string' ? customer.test_clock : customer.test_clock?.id;
  if (!clockId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  if (clock.object !== 'test_helpers.test_clock' || clock.id !== clockId || clock.livemode !== false
    || clock.status !== 'ready' || !Number.isSafeInteger(clock.frozen_time) || clock.frozen_time <= 0
    || !Number.isFinite(new Date(clock.frozen_time * 1000).getTime())) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  return { customerId, clockId, asOf: new Date(clock.frozen_time * 1000).toISOString() };
}
/** No caller-supplied comparison time: every observation is a fresh, scoped provider read. */
export async function observeStripeTestClock(db: SupabaseClient, stripe: Stripe, scope: StripeScope,
  order: TestClockOrder, env: Env = process.env) {
  const customerId = testClockCustomerForOrder(order, scope, env);
  if (!customerId) return null;
  const actualScope = await resolveStripeScope(stripe);
  if (actualScope.mode !== 'test' || actualScope.merchant !== scope.merchant) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const observed = await readStripeTestClock(stripe, customerId, order.user_id);
  const result = await db.rpc('pay_stripe_test_clock_observe', { p_order: order.id, p_customer: customerId,
    p_clock: observed.clockId, p_as_of: observed.asOf, p_binding: STRIPE_TEST_CLOCK_BINDING });
  if (result.error) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE', { cause: result.error });
  return observed;
}
/** Resolve to the original Checkout source. Renewal orders never invent a new clock binding. */
export async function refreshStripeTestClockOrder(db: SupabaseClient, stripe: Stripe, scope: StripeScope, orderId: string) {
  if (!stripeTestClockRuntimeOpen() || scope.mode !== 'test') return null;
  const result = await db.from('payment_orders').select('*').eq('id', orderId).maybeSingle();
  if (result.error || !result.data) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
  const order = result.data;
  if (order.source_order_id) {
    const source = await db.from('payment_orders').select('*').eq('id', order.source_order_id).eq('user_id', order.user_id).maybeSingle();
    if (source.error || !source.data) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
    return observeStripeTestClock(db, stripe, scope, source.data);
  }
  return observeStripeTestClock(db, stripe, scope, order);
}
/** Refresh only eligible sources, then obtain the DB-authoritative per-order times. Ordinary/live paths do no work. */
export async function refreshStripeTestClockUser(db: SupabaseClient, userId: string, env: Env = process.env, stripe?: Stripe) {
  const times = new Map<string, number>();
  if (!stripeTestClockRuntimeOpen(env)) return times;
  const sources = await db.from('payment_orders').select('*').eq('user_id', userId).eq('payment_mode', 'test')
    .eq('payment_channel', 'stripe').eq('payment_method', 'card').eq('purchase_membership_level', 'pro')
    .eq('billing_cycle', 'monthly').eq('purchase_action', 'checkout').not('checkout_request->providerRequest->>customer', 'is', null).limit(101);
  if (sources.error || !Array.isArray(sources.data)) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
  if (sources.data.length > 100) throw new Error('PAY_STRIPE_TEST_CLOCK_SOURCE_LIMIT');
  if (!sources.data.length) return times;
  const provider = stripe ?? (await import('../stripe')).getStripeClient();
  const scope = await resolveStripeScope(provider);
  if (scope.mode !== 'test') return times;
  for (const source of sources.data) await observeStripeTestClock(db, provider, scope, source, env);
  const result = await db.rpc('pay_stripe_test_clock_times', { p_user: userId });
  if (result.error || !Array.isArray(result.data)) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
  for (const row of result.data) {
    const value = Date.parse(row.now);
    if (typeof row.orderId !== 'string' || !Number.isFinite(value)) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
    times.set(row.orderId, value);
  }
  return times;
}
