import { TRPCError } from '@trpc/server';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stripeState = vi.hoisted(() => ({
  assertStripeCheckoutConfigured: vi.fn(),
  assertCheckoutRateLimit: vi.fn(),
  assertSubscriptionChangeRateLimit: vi.fn(),
  getStripePortalReturnUrl: vi.fn(),
  getOrCreateStripeCustomerId: vi.fn(),
  getStripeAppUrl: vi.fn(),
  getStripeClient: vi.fn(),
  buildStripeMetadata: vi.fn(),
  calculateDiscountedAmountCents: vi.fn(),
}));

const loggerState = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../services/stripe', () => ({
  assertStripeCheckoutConfigured: stripeState.assertStripeCheckoutConfigured,
  assertCheckoutRateLimit: stripeState.assertCheckoutRateLimit,
  assertSubscriptionChangeRateLimit: stripeState.assertSubscriptionChangeRateLimit,
  getStripePortalReturnUrl: stripeState.getStripePortalReturnUrl,
  buildStripeMetadata: stripeState.buildStripeMetadata,
  calculateDiscountedAmountCents: stripeState.calculateDiscountedAmountCents,
  getOrCreateStripeCustomerId: stripeState.getOrCreateStripeCustomerId,
  getStripeAppUrl: stripeState.getStripeAppUrl,
  getStripeClient: () => {
    const stripe = stripeState.getStripeClient();
    stripe.accounts ??= { retrieveCurrent: async () => ({ id: 'acct_fixture' }) };
    stripe.balance ??= { retrieve: async () => ({ livemode: false }) };
    return stripe;
  },
}));

vi.mock('../lib/logger', () => ({
  logger: loggerState,
}));

vi.mock('../services/stripeFulfillment', () => ({
  fulfillCreditPackageOrder: vi.fn(),
  fulfillMembershipInvoice: vi.fn(),
  fulfillPaidMembershipCheckoutSession: vi.fn(),
  syncSubscriptionState: vi.fn(),
  upsertPaymentOrderBySession: vi.fn(),
}));

import { paymentsRouter } from './payments';
import { installPurchaseFixture } from './__tests__/paymentPurchaseFixture';
import {
  fulfillMembershipInvoice,
  fulfillPaidMembershipCheckoutSession,
  syncSubscriptionState,
  upsertPaymentOrderBySession,
} from '../services/stripeFulfillment';

function createSingleQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    single() {
      return result;
    },
    maybeSingle() {
      return result;
    },
  };
}

function createMaybeSingleQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return this;
    },
    limit() {
      return this;
    },
    maybeSingle() {
      return result;
    },
  };
}

function createAwaitableQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createListQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    not() {
      return this;
    },
    order() {
      return this;
    },
    limit() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createNameLookupBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    in() {
      return result;
    },
  };
}

function createTrackedListQueryBuilder(result: Promise<unknown>, eqCalls: Array<[string, unknown]>) {
  return {
    select() {
      return this;
    },
    eq(column: string, value: unknown) {
      eqCalls.push([column, value]);
      return this;
    },
    order() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createInsertBuilder(result: Promise<unknown>, inserts: unknown[]) {
  return {
    insert(payload: unknown) {
      inserts.push(payload);
      const builder = {
        select() {
          return this;
        },
        single() {
          return result;
        },
        maybeSingle() {
          return result;
        },
        then: result.then.bind(result),
        catch: result.catch.bind(result),
        finally: result.finally.bind(result),
      };

      return builder;
    },
  };
}

function createUpdateBuilder(result: Promise<unknown>, updates: unknown[]) {
  return {
    update(payload: unknown) {
      updates.push(payload);
      const builder = {
        eq() {
          return builder;
        },
        then: result.then.bind(result),
        catch: result.catch.bind(result),
        finally: result.finally.bind(result),
      };

      return builder;
    },
  };
}

type MembershipFixtureRow = Record<string, unknown>;
type MembershipFixtureResult = { data: MembershipFixtureRow | MembershipFixtureRow[] | null; error?: unknown };
type MembershipFixtureQuery = PromiseLike<MembershipFixtureResult> & {
  select(columns: string): MembershipFixtureQuery;
  eq(column: string, value: unknown): MembershipFixtureQuery;
  order(column: string, options: { ascending: boolean }): MembershipFixtureQuery;
  limit(count: number): MembershipFixtureQuery;
  maybeSingle(): Promise<MembershipFixtureResult>;
};
type MembershipFixtureDb = {
  from(table: string): MembershipFixtureQuery;
  rpc?: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function createProtectedCaller(options: {
  supabase: {
    from(table: string): unknown;
  };
  supabaseAdmin?: {
    from(table: string): unknown;
  };
}) {
  // Fixture implementation of the safe projection RPC. Financial mutations remain explicit below.
  const userDb = options.supabase as MembershipFixtureDb;
  const hadRpc = Boolean(userDb.rpc);
  if (!userDb.rpc) userDb.rpc = async (name: string) => {
    if (name !== 'pay_common_membership_facts') throw new Error(`Unexpected RPC ${name}`);
    const subQuery = userDb.from('user_subscriptions').select('*').eq('user_id', 'user-1').order('created_at', { ascending: false }).limit(2);
    const orderQuery = userDb.from('payment_orders').select('*').eq('user_id', 'user-1').eq('item_type', 'membership_plan')
      .order('created_at', { ascending: false }).limit(1);
    const [subscriptions, orders] = await Promise.all([
      typeof subQuery.then === 'function' ? subQuery : subQuery.maybeSingle(),
      typeof orderQuery.maybeSingle === 'function' ? orderQuery.maybeSingle() : orderQuery,
    ]);
    const rows = Array.isArray(subscriptions.data) ? subscriptions.data : subscriptions.data ? [subscriptions.data] : [];
    return { error: subscriptions.error ?? orders.error, data: {
      subscriptions: rows.map(row => ({ ...row, payment_channel: row.stripe_subscription_id ? 'stripe' : null,
        mapping_state: row.stripe_subscription_id ? 'mapped' : 'none' })),
      latest_order: Array.isArray(orders.data) ? orders.data[0] ?? null : orders.data,
    } };
  };
  const adminDb = (options.supabaseAdmin ?? options.supabase) as MembershipFixtureDb;
  if ((!options.supabaseAdmin && !hadRpc) || !adminDb.rpc) installPurchaseFixture(userDb as unknown as Parameters<typeof installPurchaseFixture>[0],
    adminDb as unknown as Parameters<typeof installPurchaseFixture>[1], () => stripeState.getStripeClient());
  return paymentsRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: options.supabase,
    supabaseAuth: options.supabase,
    supabasePublic: {},
    supabaseAdmin: options.supabaseAdmin ?? options.supabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

function createSubscriptionChangeGuardHarness(options: {
  monthlyPrice?: unknown; yearlyPrice?: unknown;
  currentLevel?: string; currentCycle?: string; targetLevel?: string;
  profileResult?: () => Promise<unknown>; planResult?: () => Promise<unknown>;
  eligibilitySubscriptionResult?: () => Promise<unknown>; eligibilityOrderResult?: () => Promise<unknown>;
} = {}) {
  const targetPlanId = '123e4567-e89b-42d3-a456-426614174222';
  const targetLevel = options.targetLevel ?? 'gold';
  const currentPlanId = (options.currentLevel ?? 'pro') === targetLevel ? targetPlanId : '123e4567-e89b-42d3-a456-426614174111';
  const profile = { id: 'user-1', role: 'user', status: 'active', email: 'user@example.com',
    nickname: 'User', membership_level: options.currentLevel ?? 'pro' };
  const targetPriceIds = { monthly: `price_test_${targetLevel}_monthly`, yearly: `price_test_${targetLevel}_yearly` };
  const plan: any = { id: targetPlanId, name: targetLevel === 'gold' ? 'Gold' : 'Pro', level: targetLevel, is_active: 'true',
    monthly_price: targetLevel === 'gold' ? 2990 : 990, yearly_price: targetLevel === 'gold' ? 29900 : 9900,
    stripe_monthly_price_id: 'monthlyPrice' in options ? options.monthlyPrice : targetPriceIds.monthly,
    stripe_yearly_price_id: 'yearlyPrice' in options ? options.yearlyPrice : targetPriceIds.yearly };
  const targetPrice = (billingCycle: 'monthly' | 'yearly') => ({
    id: billingCycle === 'yearly' ? plan.stripe_yearly_price_id : plan.stripe_monthly_price_id,
    object: 'price', livemode: false, billing_scheme: 'per_unit', tax_behavior: 'unspecified',
    active: true,
    type: 'recurring',
    currency: 'usd',
    unit_amount: billingCycle === 'yearly' ? plan.yearly_price : plan.monthly_price,
    recurring: { interval: billingCycle === 'yearly' ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' },
  });
  const priceRetrieve = vi.fn().mockImplementation(async (priceId: string) => structuredClone(targetPrice(
    priceId === plan.stripe_yearly_price_id ? 'yearly' : 'monthly',
  )));
  const local: any = { user_id: 'user-1', payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test', id: 'sub-row-1', membership_plan_id: currentPlanId, stripe_subscription_id: 'sub_test_active',
    stripe_customer_id: 'cus_test_active', stripe_price_id: 'price_test_old', status: 'active',
    current_period_start: '2026-01-01T00:00:00Z', billing_cycle: options.currentCycle ?? 'monthly', cancel_at_period_end: 'false', metadata: {} };
  const remote: any = { livemode: false, id: 'sub_test_active', customer: 'cus_test_active', status: 'active',
    cancel_at_period_end: false, cancel_at: null, collection_method: 'charge_automatically',
    metadata: { userId: 'user-1' }, items: { has_more: false, data: [{ id: 'si_test_current', quantity: 1,
      price: { id: 'price_test_old' }, current_period_start: 1700000000, current_period_end: 2000000000 }] } };
  const subscriptionRetrieve = vi.fn().mockImplementation(async () => structuredClone(remote));
  const subscriptionUpdate = vi.fn().mockResolvedValue(remote);
  const invoiceList = vi.fn().mockResolvedValue({ data: [], has_more: false });
  const fullPricePreview = (billingCycle: 'monthly' | 'yearly' = 'monthly', overrides: Record<string, unknown> = {}) => {
    const amount = billingCycle === 'yearly' ? plan.yearly_price : plan.monthly_price;
    const price = billingCycle === 'yearly' ? plan.stripe_yearly_price_id : plan.stripe_monthly_price_id;
    const start = Date.UTC(2026, 8, 1) / 1000;
    const end = Date.UTC(billingCycle === 'yearly' ? 2027 : 2026, billingCycle === 'yearly' ? 8 : 9, 1) / 1000;
    return { amount_due: amount, currency: 'usd', subtotal: amount, total: amount, starting_balance: 0,
      pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
      total_discount_amounts: [], total_taxes: [], lines: { has_more: false, data: [{
        id: 'il_full_target', amount, subtotal: amount, currency: 'usd', quantity: 1,
        discount_amounts: [], discounts: [], pretax_credit_amounts: [], taxes: [],
        pricing: { price_details: { price } }, period: { start, end },
        parent: { subscription_item_details: { subscription: remote.id, subscription_item: 'si_test_current', proration: false } },
      }] }, ...overrides };
  };
  const invoicePreview = vi.fn().mockImplementation(async (params: any) => fullPricePreview(
    params.subscription_details.items[0].price === plan.stripe_yearly_price_id ? 'yearly' : 'monthly',
  ));
  const invoiceRetrieve = vi.fn().mockResolvedValue({ customer: 'cus_test_active', status: 'paid',
    parent: { subscription_details: { subscription: remote.id } }, billing_reason: 'subscription_update',
    lines: { has_more: false, data: [{ pricing: { price_details: { price: targetPriceIds.monthly } } }] } });
  const orderInserts: any[] = []; const rows: any[] = []; const orderUpdates: any[] = [];
  const userTableReads: string[] = []; let profileReadCount = 0;
  let insertError: any = null;
  stripeState.getStripeClient.mockReturnValue({ accounts: { retrieveCurrent: async () => ({ id: 'acct_fixture' }) },
    balance: { retrieve: async () => ({ livemode: false }) }, subscriptions: { retrieve: subscriptionRetrieve, update: subscriptionUpdate }, prices: { retrieve: priceRetrieve },
    invoices: { createPreview: invoicePreview, retrieve: invoiceRetrieve, list: invoiceList } });
  const baseOrder: Record<string, unknown> = { id: 'base-paid-order', user_id: 'user-1', item_type: 'membership_plan',
    item_id: currentPlanId, subscription_id: local.id, billing_cycle: local.billing_cycle, purchase_action: 'checkout',
    payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test', price_ref_id: 'ref-old-price',
    status: 'completed', payment_status: 'paid', fulfilled_at: '2026-01-01T00:00:00Z', metadata: {} };
  const grants: Record<string, unknown>[] = [{ source_order_id: baseOrder.id, subscription_id: local.id,
    membership_plan_id: currentPlanId, billing_cycle: local.billing_cycle, period_start: local.current_period_start, status: 'granted' }];
  function grantsBuilder() {
    const filters: Array<[string, unknown]> = [];
    return { select() { return this; }, eq(key: string, value: unknown) { filters.push([key, value]); return this; },
      limit: async (count: number) => ({ data: grants.filter(row => filters.every(([key, value]) => row[key] === value)).slice(0, count), error: null }) };
  }
  function mappingBuilder() {
    const filters: Array<[string, unknown]> = [];
    const result = () => {
      const common = { channel: 'stripe', merchant_namespace: 'acct_fixture', mode: 'test' };
      const refs = [
        { ...common, id: 'ref-subscription', object_type: 'subscription', subscription_id: local.id, external_id: local.stripe_subscription_id },
        { ...common, id: 'ref-old-price', object_type: 'price', external_id: 'price_test_old' },
        ...(['monthly', 'yearly'] as const).map(cycle => ({ ...common, id: `ref-${cycle}`, object_type: 'price',
          membership_plan_id: plan.id, billing_cycle: cycle, is_current: true,
          external_id: cycle === 'monthly' ? plan.stripe_monthly_price_id : plan.stripe_yearly_price_id })),
      ].filter(row => typeof row.external_id === 'string' && row.external_id.trim());
      return { data: refs.filter(row => filters.every(([key, value]) => {
        const candidate = (row as Record<string, unknown>)[key];
        return Array.isArray(value) ? value.includes(candidate) : candidate === value;
      })), error: null };
    };
    return { select() { return this; }, eq(k: string, v: unknown) { filters.push([k, v]); return this; },
      in(k: string, v: unknown) { filters.push([k, v]); return this; }, limit() { return this; },
      maybeSingle: async () => ({ ...result(), data: result().data[0] ?? null }),
      then<T>(resolve: (value: ReturnType<typeof result>) => T, reject: (reason: unknown) => T) {
        return Promise.resolve(result()).then(resolve, reject);
      } };
  }
  function ordersBuilder() {
    const filters: Array<[string, unknown]> = []; let values: any = null;
    const result = () => {
      const available = filters.some(([key]) => key === 'fulfilled_at:not') ? [baseOrder, ...rows] : rows;
      const found = available.filter(row => filters.every(([key, value]) => key === 'fulfilled_at:not' ? row.fulfilled_at != null : key === 'metadata'
        ? isDeepStrictEqual(row.metadata, JSON.parse(value as string)) : value === null ? row[key] == null : row[key] === value));
      if (values) { orderUpdates.push(values); found.forEach(row => Object.assign(row, values)); }
      return { data: structuredClone(found), error: null };
    };
    return {
      select() { return this; }, eq(k: string, v: unknown) { filters.push([k, v]); return this; },
      is(k: string, v: unknown) { filters.push([k, v]); return this; },
      not(k: string) { filters.push([`${k}:not`, null]); return this; },
      order() { return this; }, limit() { return this; },
      update(v: any) { values = v; return this; },
      maybeSingle: async () => options.eligibilityOrderResult?.() ?? { ...result(), data: result().data[0] ?? null },
      then(resolve: any, reject: any) { return Promise.resolve(result()).then(resolve, reject); },
      insert(payload: any) {
        const conflict = rows.some(r => r.stripe_checkout_session_id === payload.stripe_checkout_session_id);
        const error = insertError ?? (conflict ? { code: '23505' } : null);
        const id = `order-change-${rows.length + 1}`;
        if (!error) { orderInserts.push(payload); rows.push(structuredClone({ ...payload, id })); }
        return createSingleQueryBuilder(Promise.resolve({ data: error ? null : { id }, error }));
      },
    };
  }
  const userSupabase = { from(table: string) {
    userTableReads.push(table);
    if (table === 'profiles') { profileReadCount++; return createSingleQueryBuilder(profileReadCount === 1
      ? Promise.resolve({ data: profile, error: null }) : options.profileResult?.() ?? Promise.resolve({ data: profile, error: null })); }
    if (table === 'membership_plans') return createSingleQueryBuilder(options.planResult?.() ?? Promise.resolve({ data: plan, error: null }));
    if (table === 'user_subscriptions') return createListQueryBuilder(options.eligibilitySubscriptionResult?.()
      ?? Promise.resolve({ data: options.currentLevel === 'free' ? [] : [local], error: null }));
    if (table === 'payment_orders') return ordersBuilder();
    throw new Error(`Unexpected user table ${table}`);
  } };
  const adminSupabase = {
    async rpc(name: string, payload: Record<string, unknown>) {
      if (name === 'pay_common_prepare_change') {
        if (insertError) return { data: null, error: insertError };
        if (rows.some(row => !row.fulfilled_at && !row.purchase_closed_at)) return { data: null, error: { code: '23505' } };
        const row = { ...baseOrder, id: `order-change-${rows.length + 1}`, item_id: plan.id,
          billing_cycle: payload.p_cycle, purchase_action: 'subscription_change', fulfilled_at: null,
          price_ref_id: `ref-${payload.p_cycle}`, stripe_price_id: payload.p_price_id, stripe_subscription_id: remote.id,
          stripe_checkout_session_id: null, status: 'pending', payment_status: 'unpaid', purchase_closed_at: null,
          metadata: { ...structuredClone(payload.p_metadata as Record<string, unknown>), source: 'changeSubscriptionPlan',
            previousMembershipPlanId: local.membership_plan_id, previousBillingCycle: local.billing_cycle, productName: plan.name }, purchase_change_request: structuredClone(payload.p_request) };
        rows.push(row); orderInserts.push(row);
        return { data: structuredClone(row), error: null };
      }
      if (name === 'pay_common_finish_change') {
        const row = rows.find(row => row.id === payload.p_order_id);
        if (!row || row.fulfilled_at || row.purchase_closed_at || !isDeepStrictEqual(row.metadata, payload.p_previous)) {
          return { data: false, error: null };
        }
        row.metadata = payload.p_next;
        if (payload.p_outcome !== 'release') {
          row.purchase_closed_at = new Date().toISOString(); row.purchase_close_reason = payload.p_outcome;
          row.status = 'failed';
        }
        orderUpdates.push(structuredClone(row));
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    }, from(table: string) {
    if (table === 'payment_orders') return ordersBuilder();
    if (table === 'payment_provider_refs') return mappingBuilder();
    if (table === 'subscription_credit_grants') return grantsBuilder();
    if (table === 'user_subscriptions') return { select() { return this; }, eq() { return this; }, in() { return this; },
      limit: async () => ({ data: [local], error: null }) };
    throw new Error(`Unexpected admin write ${table}`);
  } };
  return { caller: createProtectedCaller({ supabase: userSupabase, supabaseAdmin: adminSupabase }),
    targetPlanId, subscriptionRetrieve, subscriptionUpdate, priceRetrieve, targetPrice, invoicePreview, invoiceRetrieve, invoiceList, remote, local, plan,
    rows, baseOrder, grants, orderInserts, orderUpdates, userTableReads, adminSupabase, targetPriceIds, fullPricePreview,
    setInsertError: (e: any) => { insertError = e; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fakeQuote() { return { amountDue: 2990, currency: 'usd', quotedAt: Math.floor(Date.now() / 1000),
  fingerprint: 'a'.repeat(64), freshnessProof: 'b'.repeat(64) }; }
async function getQuote(h: ReturnType<typeof createSubscriptionChangeGuardHarness>, input: { planId: string; billingCycle: 'monthly' | 'yearly' }) {
  const preview = await h.caller.previewSubscriptionPlanChange(input);
  if (preview.status !== 'quote') throw new Error('Expected financial quote');
  const { amountDue, currency, quotedAt, fingerprint, freshnessProof } = preview;
  return { amountDue, currency, quotedAt, fingerprint, freshnessProof };
}

describe('paymentsRouter error sanitization', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'local-noncredential-pay1-quote-signing';
    stripeState.assertCheckoutRateLimit.mockReset();
    stripeState.assertSubscriptionChangeRateLimit.mockReset();
    stripeState.getStripePortalReturnUrl.mockReset().mockReturnValue('https://app.example.com/profile?tab=subscription');
    stripeState.assertStripeCheckoutConfigured.mockReset();
    stripeState.getOrCreateStripeCustomerId.mockReset();
    stripeState.getStripeAppUrl.mockReset();
    stripeState.getStripeClient.mockReset();
    stripeState.buildStripeMetadata.mockReset();
    stripeState.calculateDiscountedAmountCents.mockReset();
    loggerState.error.mockReset();
    loggerState.info.mockReset();
    loggerState.warn.mockReset();
    vi.mocked(fulfillMembershipInvoice).mockReset();
    vi.mocked(fulfillPaidMembershipCheckoutSession).mockReset();
    vi.mocked(syncSubscriptionState).mockReset();
    vi.mocked(upsertPaymentOrderBySession).mockReset().mockImplementation(async (_db, session) => session);
    stripeState.getOrCreateStripeCustomerId.mockResolvedValue('cus_123');
    stripeState.getStripeAppUrl.mockReturnValue('http://localhost:3000');
    stripeState.buildStripeMetadata.mockReturnValue({});
    stripeState.calculateDiscountedAmountCents.mockReturnValue({
      baseAmountCents: 1000,
      discountedAmountCents: 1000,
      normalizedDiscount: 0,
    });
  });

  it('sanitizes Stripe configuration failures for checkout creation', async () => {
    stripeState.assertStripeCheckoutConfigured.mockImplementation(() => {
      throw new Error('STRIPE_SECRET_KEY is missing');
    });

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
                membership_level: 'free',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ supabase });

    await expect(
      caller.createCheckoutSession({
        kind: 'credit_package',
        packageId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '支付暂不可用，请稍后重试',
    });
  });

  it('sanitizes billing record query failures', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createAwaitableQueryBuilder(
            Promise.resolve({
              data: null,
              error: { message: 'permission denied for table payment_orders' },
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ supabase });

    await expect(caller.listBillingRecords()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取账单记录失败，请稍后重试',
    });
  });

  it('filters billing record reads to the current profile', async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createTrackedListQueryBuilder(
            Promise.resolve({
              data: [],
              error: null,
            }),
            eqCalls,
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ supabase });

    await expect(caller.listBillingRecords()).resolves.toEqual([]);
    expect(eqCalls).toContainEqual(['user_id', 'user-1']);
  });

  it('lists pending and terminal billing records with canonical statuses', async () => {
    const paymentOrders = [
      {
        id: 'order-pending',
        item_id: '123e4567-e89b-42d3-a456-426614174000',
        item_type: 'credit_package',
        billing_cycle: 'one_time',
        stripe_checkout_session_id: 'cs_test_pending',
        stripe_invoice_id: null,
        amount_total: 1000,
        currency: 'usd',
        status: 'pending',
        payment_status: 'unpaid',
        fulfilled_at: null,
        created_at: '2026-06-07T09:00:00.000Z',
      },
      {
        id: 'order-failed',
        item_id: '123e4567-e89b-42d3-a456-426614174000',
        item_type: 'credit_package',
        billing_cycle: 'one_time',
        stripe_checkout_session_id: 'cs_test_failed',
        stripe_invoice_id: null,
        amount_total: 1000,
        currency: 'usd',
        status: 'failed',
        payment_status: 'unpaid',
        fulfilled_at: null,
        created_at: '2026-06-07T09:01:00.000Z',
      },
      {
        id: 'order-canceled',
        item_id: '123e4567-e89b-42d3-a456-426614174111',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_checkout_session_id: 'cs_test_canceled',
        stripe_invoice_id: null,
        amount_total: 990,
        currency: 'usd',
        status: 'cancelled',
        payment_status: 'unpaid',
        fulfilled_at: null,
        created_at: '2026-06-07T09:02:00.000Z',
      },
      {
        id: 'order-expired',
        item_id: '123e4567-e89b-42d3-a456-426614174111',
        item_type: 'membership_plan',
        billing_cycle: 'yearly',
        stripe_checkout_session_id: 'cs_test_expired',
        stripe_invoice_id: null,
        amount_total: 9900,
        currency: 'usd',
        status: 'expired',
        payment_status: 'unpaid',
        fulfilled_at: null,
        created_at: '2026-06-07T09:03:00.000Z',
      },
      {
        id: 'order-failed-invoice',
        item_id: '123e4567-e89b-42d3-a456-426614174111',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_checkout_session_id: null,
        stripe_invoice_id: 'in_test_failed_invoice',
        amount_total: 990,
        currency: 'usd',
        status: 'failed',
        payment_status: 'open',
        fulfilled_at: null,
        created_at: '2026-06-07T09:03:30.000Z',
      },
      {
        id: 'order-refunded',
        item_id: '123e4567-e89b-42d3-a456-426614174000',
        item_type: 'credit_package',
        billing_cycle: 'one_time',
        stripe_checkout_session_id: 'cs_test_refunded',
        stripe_invoice_id: null,
        amount_total: 1000,
        currency: 'usd',
        status: 'refunded',
        payment_status: 'refunded',
        fulfilled_at: '2026-06-07T09:04:00.000Z',
        created_at: '2026-06-07T09:04:00.000Z',
      },
      {
        id: 'order-partial',
        item_id: '123e4567-e89b-42d3-a456-426614174000',
        item_type: 'credit_package',
        billing_cycle: 'one_time',
        stripe_checkout_session_id: 'cs_test_partial',
        stripe_invoice_id: null,
        amount_total: 1000,
        currency: 'usd',
        status: 'partial_refunded',
        payment_status: 'partial_refunded',
        fulfilled_at: '2026-06-07T09:05:00.000Z',
        created_at: '2026-06-07T09:05:00.000Z',
      },
      {
        id: 'order-plan-change-lock',
        item_id: '123e4567-e89b-42d3-a456-426614174111',
        item_type: 'membership_plan',
        billing_cycle: 'monthly',
        stripe_checkout_session_id: null,
        stripe_invoice_id: null,
        amount_total: null,
        currency: 'usd',
        status: 'completed',
        payment_status: 'paid',
        fulfilled_at: '2026-06-07T09:06:00.000Z',
        created_at: '2026-06-07T09:06:00.000Z',
        metadata: {
          source: 'changeSubscriptionPlan',
        },
      },
    ];

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createAwaitableQueryBuilder(
            Promise.resolve({
              data: paymentOrders,
              error: null,
            }),
          );
        }

        if (table === 'credit_packages') {
          return createNameLookupBuilder(
            Promise.resolve({
              data: [
                {
                  id: '123e4567-e89b-42d3-a456-426614174000',
                  name: 'Starter Credits',
                },
              ],
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createNameLookupBuilder(
            Promise.resolve({
              data: [
                {
                  id: '123e4567-e89b-42d3-a456-426614174111',
                  name: 'Pro',
                },
              ],
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller({ supabase });

    const records = await caller.listBillingRecords();
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'order-pending', status: 'pending', title: 'Starter Credits' }),
        expect.objectContaining({ id: 'order-failed', status: 'failed', title: 'Starter Credits' }),
        expect.objectContaining({ id: 'order-canceled', status: 'canceled', title: 'Pro' }),
        expect.objectContaining({ id: 'order-expired', status: 'expired', title: 'Pro' }),
        expect.objectContaining({ id: 'order-failed-invoice', status: 'failed', title: 'Pro' }),
        expect.objectContaining({ id: 'order-refunded', status: 'refunded', title: 'Starter Credits' }),
        expect.objectContaining({ id: 'order-partial', status: 'partially_refunded', title: 'Starter Credits' }),
      ]),
    );
    expect(records).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'order-plan-change-lock' }),
      ]),
    );
  });

  it('admits the order through the service-role client before creating Stripe checkout', async () => {
    const sessionCreate = vi.fn().mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      payment_status: 'unpaid',
    });
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
                membership_level: 'free',
              },
              error: null,
            }),
          );
        }

        if (table === 'credit_packages') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174000',
                name: 'Test Package',
                active: 'true',
                stripe_price_id: 'price_test_123',
                price: 1000,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions' || table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user-scoped table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'credit_package',
        packageId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123',
      sessionId: 'cs_test_123',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(orderInserts).toHaveLength(1);
    expect(orderInserts[0]).toMatchObject({
      user_id: 'user-1',
      item_type: 'credit_package',
      item_id: '123e4567-e89b-42d3-a456-426614174000',
      status: 'pending',
      payment_status: 'unpaid',
    });
  });

  it('rejects credit package checkout for free profiles with active Stripe subscriptions before Stripe writes', async () => {
    const sessionCreate = vi.fn();
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'free',
              },
              error: null,
            }),
          );
        }

        if (table === 'credit_packages') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174000',
                name: 'Test Package',
                active: 'true',
                stripe_price_id: 'price_test_123',
                price: 1000,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'sub-row-1',
                stripe_subscription_id: 'sub_test_active',
                status: 'active',
                cancel_at_period_end: 'false',
                metadata: {},
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'credit_package',
        packageId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '会员状态存在冲突，请联系管理员处理后再操作。',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(orderInserts).toHaveLength(0);
  });

  it('rejects duplicate membership checkout before Stripe customer lookup, session creation, or order insert', async () => {
    const sessionCreate = vi.fn();
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'pro',
              },
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174111',
                name: 'Pro',
                level: 'pro',
                is_active: 'true',
                stripe_monthly_price_id: 'price_test_pro_monthly',
                stripe_yearly_price_id: 'price_test_pro_yearly',
                monthly_price: 990,
                yearly_price: 9900,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                status: 'active',
                cancel_at_period_end: 'false',
                metadata: {},
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };

    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'membership_plan',
        planId: '123e4567-e89b-42d3-a456-426614174111',
        billingCycle: 'monthly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '当前套餐仍有效，无需重复购买。',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(orderInserts).toHaveLength(0);
  });

  it('rejects upgrade-needed membership checkout before Stripe customer lookup, session creation, or order insert', async () => {
    const sessionCreate = vi.fn();
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'pro',
              },
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174222',
                name: 'Gold',
                level: 'gold',
                is_active: 'true',
                stripe_monthly_price_id: 'price_test_gold_monthly',
                stripe_yearly_price_id: 'price_test_gold_yearly',
                monthly_price: 2990,
                yearly_price: 29900,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
                metadata: {},
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };

    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'membership_plan',
        planId: '123e4567-e89b-42d3-a456-426614174222',
        billingCycle: 'yearly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '当前会员订阅仍有效，请通过升级套餐调整现有订阅，不会创建新的 Checkout。',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(orderInserts).toHaveLength(0);
  });

  it.each([
    'user_subscriptions',
    'payment_orders',
  ] as const)(
    'sanitizes rejected %s eligibility facts before subscription change side effects',
    async (rejectedTable) => {
      const rejectedResult = () => Promise.reject(new Error(`${rejectedTable} facts timeout`));
      const harness = createSubscriptionChangeGuardHarness(
        rejectedTable === 'user_subscriptions'
          ? { eligibilitySubscriptionResult: rejectedResult }
          : { eligibilityOrderResult: rejectedResult },
      );

      await expect(
        harness.caller.changeSubscriptionPlan({
          planId: harness.targetPlanId,
          billingCycle: 'yearly',
          expected: fakeQuote(),
        }),
      ).rejects.toMatchObject<Partial<TRPCError>>({
        code: 'SERVICE_UNAVAILABLE',
        message: '会员状态暂不可用，请稍后重试',
      });

      expect(loggerState.error).toHaveBeenCalledWith(
        'billing',
        'payments_change_subscription_plan_stage_failed',
        expect.objectContaining({ stage: 'eligibility_read' }),
      );
      expect(harness.subscriptionRetrieve).not.toHaveBeenCalled();
      expect(harness.subscriptionUpdate).not.toHaveBeenCalled();
      expect(harness.orderInserts).toHaveLength(0);
      expect(syncSubscriptionState).not.toHaveBeenCalled();
      expect(harness.userTableReads.filter((table) => table === 'user_subscriptions')).toHaveLength(1);
      expect(harness.userTableReads.filter((table) => table === 'payment_orders')).toHaveLength(1);
    },
  );

  it.each([
    [
      'database error',
      () => Promise.resolve({ data: null, error: { code: '42501' } }),
      'SERVICE_UNAVAILABLE',
      '用户资料服务暂不可用，请稍后重试',
    ],
    [
      'rejected query',
      () => Promise.reject(new Error('profile network timeout')),
      'SERVICE_UNAVAILABLE',
      '用户资料服务暂不可用，请稍后重试',
    ],
    [
      'successful not-found',
      () => Promise.resolve({ data: null, error: null }),
      'NOT_FOUND',
      '用户资料不存在，无法升级订阅',
    ],
  ] as const)(
    'distinguishes profile %s before subscription change side effects',
    async (_caseName, profileResult, errorCode, message) => {
      const harness = createSubscriptionChangeGuardHarness({ profileResult });

      await expect(
        harness.caller.changeSubscriptionPlan({
          planId: harness.targetPlanId,
          billingCycle: 'yearly',
          expected: fakeQuote(),
        }),
      ).rejects.toMatchObject<Partial<TRPCError>>({
        code: errorCode,
        message,
      });

      expect(harness.subscriptionRetrieve).not.toHaveBeenCalled();
      expect(harness.subscriptionUpdate).not.toHaveBeenCalled();
      expect(harness.orderInserts).toHaveLength(0);
      expect(syncSubscriptionState).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'database error',
      () => Promise.resolve({ data: null, error: { code: '57014' } }),
      'SERVICE_UNAVAILABLE',
      '会员套餐服务暂不可用，请稍后重试',
    ],
    [
      'rejected query',
      () => Promise.reject(new Error('membership plan network timeout')),
      'SERVICE_UNAVAILABLE',
      '会员套餐服务暂不可用，请稍后重试',
    ],
    [
      'successful not-found',
      () => Promise.resolve({ data: null, error: null }),
      'NOT_FOUND',
      '会员套餐不存在',
    ],
  ] as const)(
    'distinguishes membership plan %s before subscription change side effects',
    async (_caseName, planResult, errorCode, message) => {
      const harness = createSubscriptionChangeGuardHarness({ planResult });

      await expect(
        harness.caller.changeSubscriptionPlan({
          planId: harness.targetPlanId,
          billingCycle: 'yearly',
          expected: fakeQuote(),
        }),
      ).rejects.toMatchObject<Partial<TRPCError>>({
        code: errorCode,
        message,
      });

      expect(harness.subscriptionRetrieve).not.toHaveBeenCalled();
      expect(harness.subscriptionUpdate).not.toHaveBeenCalled();
      expect(harness.orderInserts).toHaveLength(0);
      expect(syncSubscriptionState).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['gold', 'monthly', 'gold', 'yearly'],
    ['pro', 'yearly', 'gold', 'yearly'],
  ] as const)('ignores later-arriving prior Pro monthly payment for current %s %s upgrade', async (currentLevel, currentCycle, targetLevel, billingCycle) => {
    const h = createSubscriptionChangeGuardHarness({ currentLevel, currentCycle, targetLevel });
    h.rows.push({ ...h.baseOrder, id: 'late-prior-pro-payment', item_id: 'old-pro-plan', billing_cycle: 'monthly',
      price_ref_id: 'ref-stale-price', fulfilled_at: '2026-12-01T00:00:00Z' });
    h.grants.push({ ...h.grants[0], source_order_id: 'late-prior-pro-payment', membership_plan_id: 'old-pro-plan',
      billing_cycle: 'monthly', period_start: '2025-12-01T00:00:00Z' });
    const input = { planId: h.targetPlanId, billingCycle };
    const quote = await getQuote(h, input);
    await h.caller.changeSubscriptionPlan({ ...input, expected: quote });
    expect(h.subscriptionUpdate).toHaveBeenCalledOnce();
    expect(h.orderInserts[0].purchase_change_request.originalPrice).toBe('price_test_old');
  });

  it.each(['missing', 'ambiguous'] as const)('rejects %s current paid-term source before provider dispatch', async (state) => {
    const h = createSubscriptionChangeGuardHarness();
    if (state === 'missing') h.grants.splice(0);
    else h.grants.push({ ...h.grants[0], source_order_id: 'second-invoice-same-period' });
    await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle: 'monthly' }))
      .rejects.toBeInstanceOf(TRPCError);
    expect(h.subscriptionUpdate).not.toHaveBeenCalled();
    expect(h.invoicePreview).not.toHaveBeenCalled();
  });

  it.each([
    ['pro', 'monthly', 'gold', 'monthly'], ['pro', 'monthly', 'pro', 'yearly'],
    ['pro', 'monthly', 'gold', 'yearly'], ['pro', 'yearly', 'gold', 'yearly'],
    ['gold', 'monthly', 'gold', 'yearly'],
  ] as const)('previews and upgrades %s %s -> %s %s on the existing subscription', async (currentLevel, currentCycle, targetLevel, billingCycle) => {
    const h = createSubscriptionChangeGuardHarness({ currentLevel, currentCycle, targetLevel });
    const input = { planId: h.targetPlanId, billingCycle };
    const quote = await h.caller.previewSubscriptionPlanChange(input);
    const targetAmount = billingCycle === 'yearly' ? h.plan.yearly_price : h.plan.monthly_price;
    const targetPrice = billingCycle === 'yearly' ? h.plan.stripe_yearly_price_id : h.plan.stripe_monthly_price_id;
    expect(quote).toMatchObject({ amountDue: targetAmount, currency: 'usd', annualAmount: billingCycle === 'yearly' ? targetAmount : null });
    expect(quote).not.toHaveProperty('subscriptionId'); expect(quote).not.toHaveProperty('customerId');
    expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
    expect(h.invoicePreview).toHaveBeenCalledWith(expect.objectContaining({ subscription: 'sub_test_active', subscription_details: {
      items: [{ id: 'si_test_current', price: targetPrice }], billing_cycle_anchor: 'now', proration_behavior: 'none',
    } }));
    expect(h.invoicePreview.mock.calls[0][0].subscription_details).not.toHaveProperty('proration_date');
    if (quote.status !== 'quote') throw new Error('Expected financial quote');
    const { amountDue, currency, quotedAt, fingerprint, freshnessProof } = quote;
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected: { amountDue, currency, quotedAt, fingerprint, freshnessProof } }))
      .resolves.toMatchObject({ status: 'pending_fulfillment' });
    expect(h.orderInserts).toHaveLength(1);
    expect(h.subscriptionUpdate).toHaveBeenCalledWith('sub_test_active', expect.objectContaining({
      items: [{ id: 'si_test_current', price: targetPrice }],
      billing_cycle_anchor: 'now', proration_behavior: 'none', payment_behavior: 'error_if_incomplete',
    }), { idempotencyKey: 'subscription-change:order-change-1' });
    expect(h.priceRetrieve).toHaveBeenCalledTimes(2);
    expect(h.priceRetrieve).toHaveBeenNthCalledWith(1, targetPrice);
    expect(h.priceRetrieve).toHaveBeenNthCalledWith(2, targetPrice);
    expect(h.subscriptionUpdate.mock.calls[0][1]).not.toHaveProperty('proration_date');
    expect(h.subscriptionUpdate.mock.calls[0][1]).not.toHaveProperty('cancel_at_period_end');
    expect(syncSubscriptionState).not.toHaveBeenCalled(); expect(fulfillMembershipInvoice).not.toHaveBeenCalled();
  });

  it.each([
    'amount-below-catalog', 'amount-above-catalog', 'currency', 'partial-lines', 'old-price-credit',
    'target-proration', 'missing-target-price', 'wrong-period', 'discount', 'tax', 'zero-tax', 'zero-total-tax',
    'customer-balance',
  ])('rejects non-full-price preview evidence: %s', async problem => {
    const h = createSubscriptionChangeGuardHarness();
    const preview: any = h.fullPricePreview('monthly');
    if (problem === 'amount-below-catalog') preview.amount_due--;
    if (problem === 'amount-above-catalog') preview.amount_due++;
    if (problem === 'currency') preview.currency = 'eur';
    if (problem === 'partial-lines') preview.lines.has_more = true;
    if (problem === 'old-price-credit') preview.lines.data.push({
      ...structuredClone(preview.lines.data[0]), id: 'il_old_credit', amount: -100,
      subtotal: -100, pricing: { price_details: { price: 'price_test_old' } },
      parent: { subscription_item_details: { subscription: h.remote.id, subscription_item: 'si_test_current', proration: true } },
    });
    if (problem === 'target-proration') preview.lines.data[0].parent.subscription_item_details.proration = true;
    if (problem === 'missing-target-price') preview.lines.data[0].pricing.price_details.price = 'price_test_old';
    if (problem === 'wrong-period') preview.lines.data[0].period.end = preview.lines.data[0].period.start + (31 * 24 * 60 * 60);
    if (problem === 'discount') preview.lines.data[0].discount_amounts = [{ amount: 1 }];
    if (problem === 'tax') preview.lines.data[0].taxes = [{ amount: 1 }];
    if (problem === 'zero-tax') preview.lines.data[0].taxes = [{ amount: 0 }];
    if (problem === 'zero-total-tax') preview.total_taxes = [{ amount: 0 }];
    if (problem === 'customer-balance') preview.starting_balance = -1;
    h.invoicePreview.mockResolvedValue(preview);
    await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle: 'monthly' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it.each(['monthly', 'yearly'] as const)('rejects a target Price whose configured cadence is not exact %s before preview or update', async billingCycle => {
    const h = createSubscriptionChangeGuardHarness();
    const target = h.targetPrice(billingCycle);
    h.priceRetrieve.mockResolvedValue({
      ...target,
      recurring: billingCycle === 'monthly'
        ? { interval: 'day', interval_count: 28 }
        : { interval: 'month', interval_count: 12 },
    });
    await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.invoicePreview).not.toHaveBeenCalled();
    expect(h.orderInserts).toHaveLength(0);
    expect(h.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('keeps quote time outside the semantic fingerprint', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const first = await getQuote(h, input); vi.advanceTimersByTime(1000); const second = await getQuote(h, input);
    expect(second.quotedAt).toBe(first.quotedAt + 1); expect(second.fingerprint).toBe(first.fingerprint);
    expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('rejects a refreshed quotedAt without its server-authenticated freshness proof', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const issued = await getQuote(h, input); vi.advanceTimersByTime(1000);
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected: { ...issued, quotedAt: issued.quotedAt + 1 } }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['gold', 'monthly', 'pro', 'monthly'], ['pro', 'yearly', 'gold', 'monthly'],
    ['pro', 'monthly', 'pro', 'monthly'], ['free', 'monthly', 'gold', 'monthly'],
  ] as const)('denies illegal transition %s %s -> %s %s before provider calls', async (currentLevel, currentCycle, targetLevel, billingCycle) => {
    const h = createSubscriptionChangeGuardHarness({ currentLevel, currentCycle, targetLevel });
    for (const method of ['previewSubscriptionPlanChange', 'changeSubscriptionPlan'] as const) {
      await expect(h.caller[method]({ planId: h.targetPlanId, billingCycle, ...(method === 'changeSubscriptionPlan' ? { expected: fakeQuote() } : {}) } as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(h.subscriptionRetrieve).not.toHaveBeenCalled(); expect(h.orderInserts).toHaveLength(0);
  });

  it.each(['monthly', 'yearly'] as const)('fails closed for malformed %s catalog configuration', async (billingCycle) => {
    for (const amount of [0, -1, null, undefined, '2990', 1.5, NaN]) {
      const h = createSubscriptionChangeGuardHarness(); h.plan[billingCycle + '_price'] = amount;
      await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle })).rejects.toBeDefined();
      await expect(h.caller.changeSubscriptionPlan({ planId: h.targetPlanId, billingCycle, expected: fakeQuote() })).rejects.toBeDefined();
      expect(h.subscriptionRetrieve).not.toHaveBeenCalled(); expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
    }
    for (const price of [null, '', '   ']) {
      const h = createSubscriptionChangeGuardHarness(); h.plan['stripe_' + billingCycle + '_price_id'] = price;
      await expect(h.caller.changeSubscriptionPlan({ planId: h.targetPlanId, billingCycle, expected: fakeQuote() })).rejects.toBeDefined();
      expect(h.subscriptionRetrieve).not.toHaveBeenCalled(); expect(h.orderInserts).toHaveLength(0);
    }
  });

  it.each(['customer', 'metadata', 'id', 'cancel_at_period_end', 'cancel_at', 'past_due', 'incomplete', 'unpaid', 'items', 'quantity'])(
    'rejects remote %s before preview/order/update', async (problem) => {
      const h = createSubscriptionChangeGuardHarness();
      if (problem === 'customer') h.remote.customer = 'cus_wrong';
      else if (problem === 'metadata') h.remote.metadata.userId = 'wrong-user';
      else if (problem === 'id') h.remote.id = 'sub_wrong';
      else if (problem === 'cancel_at_period_end') h.remote.cancel_at_period_end = true;
      else if (problem === 'cancel_at') h.remote.cancel_at = 2000000000;
      else if (problem === 'items') h.remote.items.data.push(h.remote.items.data[0]);
      else if (problem === 'quantity') h.remote.items.data[0].quantity = 2;
      else h.remote.status = problem;
      await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle: 'monthly' })).rejects.toBeDefined();
      await expect(h.caller.changeSubscriptionPlan({ planId: h.targetPlanId, billingCycle: 'monthly', expected: fakeQuote() })).rejects.toBeDefined();
      expect(h.invoicePreview).not.toHaveBeenCalled(); expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
    });

  it('requires restoration for local scheduled cancellation without altering rights', async () => {
    const h = createSubscriptionChangeGuardHarness(); h.local.cancel_at_period_end = 'true';
    await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle: 'monthly' })).rejects.toMatchObject({ message: expect.stringContaining('恢复续费') });
    expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionRetrieve).not.toHaveBeenCalled();
  });

  it.each(['TOO_MANY_REQUESTS', 'SERVICE_UNAVAILABLE'] as const)('rate limit %s blocks preview and mutation before Stripe', async code => {
    const h = createSubscriptionChangeGuardHarness(); stripeState.assertSubscriptionChangeRateLimit.mockRejectedValue(new TRPCError({ code }));
    await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle: 'monthly' })).rejects.toMatchObject({ code });
    await expect(h.caller.changeSubscriptionPlan({ planId: h.targetPlanId, billingCycle: 'monthly', expected: fakeQuote() })).rejects.toMatchObject({ code });
    expect(h.subscriptionRetrieve).not.toHaveBeenCalled(); expect(h.orderInserts).toHaveLength(0);
  });

  it.each(['amount', 'currency', 'catalog', 'term', 'expired'])('requires reconfirmation on %s drift before any durable write', async field => {
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    if (field === 'amount') h.invoicePreview.mockResolvedValue(h.fullPricePreview('monthly', { amount_due: 2991 }));
    if (field === 'currency') h.invoicePreview.mockResolvedValue(h.fullPricePreview('monthly', { currency: 'eur' }));
    if (field === 'catalog') h.plan.monthly_price++;
    if (field === 'term') h.remote.items.data[0].current_period_end++;
    if (field === 'expired') expected.quotedAt -= 301;
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'free', 'missing-profile', 'missing-plan', 'local-payment-attention'])('rejects %s before provider effects', async problem => {
    const h = createSubscriptionChangeGuardHarness(problem === 'missing-profile' ? { profileResult: async () => ({ data: null, error: null }) }
      : problem === 'missing-plan' ? { planResult: async () => ({ data: null, error: null }) } : {});
    if (problem === 'inactive') h.plan.is_active = 'false';
    if (problem === 'free') h.plan.level = 'free';
    if (problem === 'local-payment-attention') h.local.status = 'past_due';
    await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle: 'monthly' })).rejects.toBeDefined();
    expect(h.subscriptionRetrieve).not.toHaveBeenCalled(); expect(h.orderInserts).toHaveLength(0);
  });

  it('rejects client-controlled subscription/customer identifiers', async () => {
    const h = createSubscriptionChangeGuardHarness();
    await expect(h.caller.previewSubscriptionPlanChange({ planId: h.targetPlanId, billingCycle: 'monthly', customerId: 'cus_other' } as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.subscriptionRetrieve).not.toHaveBeenCalled();
  });

  it.each(['card_declined', 'authentication_required'])('releases only explicitly rejected %s payment without rights or credit writes', async code => {
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.subscriptionUpdate.mockRejectedValue({ type: 'StripeCardError', statusCode: 402, code });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.rows[0]).toMatchObject({ status: 'failed', stripe_checkout_session_id: null });
    expect(syncSubscriptionState).not.toHaveBeenCalled(); expect(fulfillMembershipInvoice).not.toHaveBeenCalled();
  });

  it('keeps transport-before-apply pending and recovers with the same order and idempotency key', async () => {
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.subscriptionUpdate.mockRejectedValueOnce({ type: 'StripeConnectionError' });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(h.rows[0].status).toBe('pending'); expect(h.orderUpdates.filter(u => u.status === 'failed')).toHaveLength(0);
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).resolves.toMatchObject({ status: 'pending_fulfillment' });
    expect(h.orderInserts).toHaveLength(1); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(2);
    expect(h.subscriptionUpdate.mock.calls[0]).toEqual(h.subscriptionUpdate.mock.calls[1]);
  });

  it('recovers applied transport timeout without a second update or direct entitlement sync', async () => {
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.subscriptionUpdate.mockImplementationOnce(async (_id, params) => {
      h.remote.items.data[0].price.id = 'price_test_gold_monthly'; h.remote.metadata = params.metadata; h.remote.latest_invoice = 'in_upgrade';
      throw { type: 'StripeConnectionError' };
    });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).resolves.toMatchObject({ status: 'pending_fulfillment' });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).resolves.toMatchObject({ status: 'pending_fulfillment' });
    expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1); expect(h.orderInserts).toHaveLength(1); expect(syncSubscriptionState).not.toHaveBeenCalled();
  });

  it('retains unprovable outcomes and blocks a different target and aged retry', async () => {
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.subscriptionUpdate.mockImplementationOnce(async () => { h.subscriptionRetrieve.mockRejectedValue(new Error('read timeout')); throw new Error('timeout'); });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toBeDefined();
    expect(h.rows[0].status).toBe('pending');
    await expect(h.caller.changeSubscriptionPlan({ ...input, billingCycle: 'yearly', expected })).rejects.toMatchObject({ message: expect.stringContaining('正在处理中') });
    h.subscriptionRetrieve.mockResolvedValue(h.remote); h.rows[0].metadata.upgradeAttempt.createdAt -= 24 * 3600000;
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toBeDefined();
    expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1); expect(h.orderInserts).toHaveLength(1);
  });

  it.each(['preview', 'confirm'])('retires expired proven-old attempts via %s and requires a separately confirmed fresh attempt', async endpoint => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.subscriptionUpdate.mockRejectedValueOnce(new Error('transport-before-apply'));
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    vi.advanceTimersByTime(301000);
    await expect(endpoint === 'preview' ? h.caller.previewSubscriptionPlanChange(input)
      : h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('报价已过期') });
    expect(h.rows[0]).toMatchObject({ status: 'failed', stripe_checkout_session_id: null });
    expect(h.invoiceList).toHaveBeenCalled(); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1);
    const fresh = await getQuote(h, input);
    expect(fresh.quotedAt).toBe(expected.quotedAt + 301); expect(fresh.amountDue).toBe(2990);
    expect(h.orderInserts).toHaveLength(1); // Preview alone does not replace the attempt.
    await h.caller.changeSubscriptionPlan({ ...input, expected: fresh });
    expect(h.orderInserts).toHaveLength(2); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(2);
    expect(h.subscriptionUpdate.mock.calls[1][1]).not.toHaveProperty('proration_date');
    expect(h.subscriptionUpdate.mock.calls[1][2].idempotencyKey).not.toBe(h.subscriptionUpdate.mock.calls[0][2].idempotencyKey);
    expect(h.rows.filter(r => r.status === 'pending')).toHaveLength(1);
  });

  it('allows recovery at the TTL boundary with identical parameters and returns the fresh stored preview', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.subscriptionUpdate.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toBeDefined();
    vi.advanceTimersByTime(300000);
    expect(await getQuote(h, input)).toEqual(expected);
    await h.caller.changeSubscriptionPlan({ ...input, expected });
    expect(h.subscriptionUpdate.mock.calls[1]).toEqual(h.subscriptionUpdate.mock.calls[0]);
    expect(h.orderInserts).toHaveLength(1);
  });

  it.each(['preview', 'confirm'])('returns pending fulfillment for an applied expired attempt via %s without showing a quote', async endpoint => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.subscriptionUpdate.mockImplementationOnce(async (_id, params) => {
      h.remote.items.data[0].price.id = 'price_test_gold_monthly'; h.remote.metadata = params.metadata;
      h.remote.latest_invoice = 'in_upgrade'; throw new Error('transport-after-apply');
    });
    await h.caller.changeSubscriptionPlan({ ...input, expected }); vi.advanceTimersByTime(86400000);
    const result = await (endpoint === 'preview' ? h.caller.previewSubscriptionPlanChange(input)
      : h.caller.changeSubscriptionPlan({ ...input, expected }));
    expect(result).toEqual({ action: 'changeSubscriptionPlan', status: 'pending_fulfillment' });
    expect(h.rows[0].status).toBe('pending'); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1);
    expect(h.orderInserts).toHaveLength(1); expect(syncSubscriptionState).not.toHaveBeenCalled();
  });

  it.each(['list-error', 'partial-history', 'target-invoice', 'latest-target', 'attempt-metadata', 'partial-lines', 'read-error'])('retains an expired lock when old-price evidence is ambiguous: %s', async evidence => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input); h.subscriptionUpdate.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toBeDefined(); vi.advanceTimersByTime(3600000);
    const invoice: any = { id: 'in_target', customer: h.remote.customer, parent: { subscription_details: { subscription: h.remote.id } },
      lines: { has_more: false, data: [{ pricing: { price_details: { price: 'price_test_gold_monthly' } } }] } };
    if (evidence === 'list-error') h.invoiceList.mockRejectedValue(new Error('timeout'));
    if (evidence === 'partial-history') h.invoiceList.mockResolvedValue({ data: [], has_more: true });
    if (evidence === 'target-invoice') h.invoiceList.mockResolvedValue({ data: [invoice], has_more: false });
    if (evidence === 'latest-target') { h.remote.latest_invoice = invoice.id; h.invoiceRetrieve.mockResolvedValue(invoice); }
    if (evidence === 'attempt-metadata') { h.remote.metadata.upgradeAttemptId = h.rows[0].id; }
    if (evidence === 'partial-lines') { invoice.lines = { has_more: true, data: [] }; h.invoiceList.mockResolvedValue({ data: [invoice], has_more: false }); }
    if (evidence === 'read-error') h.subscriptionRetrieve.mockRejectedValue(new Error('timeout'));
    await expect(h.caller.previewSubscriptionPlanChange(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(h.rows[0].status).toBe('pending'); expect(h.rows[0].purchase_closed_at).toBeNull();
    expect(h.orderInserts).toHaveLength(1); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent stale retirement and replacement, including an in-flight recovery crossing TTL', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input); h.subscriptionUpdate.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toBeDefined();
    vi.advanceTimersByTime(299000);
    let enter!: () => void; let finish!: () => void;
    const entered = new Promise<void>(r => { enter = r; }); const blocked = new Promise<void>(r => { finish = r; });
    h.subscriptionUpdate.mockImplementationOnce(async () => { enter(); await blocked; throw new Error('timeout'); });
    const recovery = h.caller.changeSubscriptionPlan({ ...input, expected }).catch(e => e);
    await entered; vi.advanceTimersByTime(2000);
    await expect(h.caller.previewSubscriptionPlanChange(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(h.rows[0].status).toBe('pending'); finish(); await recovery;
    const expirations = await Promise.allSettled([h.caller.changeSubscriptionPlan({ ...input, expected }), h.caller.previewSubscriptionPlanChange(input)]);
    expect(expirations.every(r => r.status === 'rejected')).toBe(true);
    expect(h.rows[0].status).toBe('failed');
    const fresh = await getQuote(h, input);
    await Promise.allSettled([h.caller.changeSubscriptionPlan({ ...input, expected: fresh }), h.caller.changeSubscriptionPlan({ ...input, expected: fresh })]);
    expect(h.orderInserts).toHaveLength(2); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(3);
    expect(h.rows.filter(r => r.status === 'pending')).toHaveLength(1);
  });

  it('does not overwrite a webhook transition that wins during stale retirement', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input); h.subscriptionUpdate.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toBeDefined(); vi.advanceTimersByTime(301000);
    h.invoiceList.mockImplementationOnce(async () => {
      h.rows[0].status = 'completed'; h.rows[0].fulfilled_at = '2026-09-05T00:05:01Z';
      return { data: [], has_more: false };
    });
    await expect(h.caller.previewSubscriptionPlanChange(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(h.rows[0].status).toBe('completed'); expect(h.orderInserts).toHaveLength(1);
    expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1);
  });

  it('never ages out a crashed execution holder or sends a quote that expires during re-preview', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T00:00:00Z'));
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    h.invoicePreview.mockImplementationOnce(async () => { vi.advanceTimersByTime(301000); return h.fullPricePreview('monthly'); });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.orderInserts).toHaveLength(0); expect(h.subscriptionUpdate).not.toHaveBeenCalled();
    const fresh = await getQuote(h, input); h.subscriptionUpdate.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected: fresh })).rejects.toBeDefined();
    h.rows[0].metadata.upgradeExecution = 'crashed-process'; vi.advanceTimersByTime(86400000);
    await expect(h.caller.previewSubscriptionPlanChange(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(h.rows[0].status).toBe('pending'); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1);
  });

  it('preserves durable lock conflicts and insert failure before update', async () => {
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input); h.setInsertError({ code: '23505' });
    await expect(h.caller.changeSubscriptionPlan({ ...input, expected })).rejects.toMatchObject({ message: expect.stringContaining('正在处理中') });
    expect(h.subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('serializes concurrent clicks with one durable row and identical Stripe attempt parameters', async () => {
    const h = createSubscriptionChangeGuardHarness(); const input = { planId: h.targetPlanId, billingCycle: 'monthly' as const };
    const expected = await getQuote(h, input);
    await Promise.allSettled([h.caller.changeSubscriptionPlan({ ...input, expected }), h.caller.changeSubscriptionPlan({ ...input, expected })]);
    expect(h.orderInserts).toHaveLength(1); expect(h.subscriptionUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns a membership eligibility matrix that matches checkout guard actions', async () => {
    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
                membership_level: 'pro',
              },
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createAwaitableQueryBuilder(
            Promise.resolve({
              data: [
                { id: 'plan-free', level: 'free', is_active: 'true' },
                { id: 'plan-pro', level: 'pro', is_active: 'true' },
                { id: 'plan-gold', level: 'gold', is_active: 'true' },
              ],
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'sub-row-1',
                membership_plan_id: 'plan-pro',
                stripe_subscription_id: 'sub_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
                metadata: {},
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
    });

    await expect(caller.getMembershipEligibilityMatrix()).resolves.toMatchObject({
      currentLevel: 'pro',
      entries: expect.arrayContaining([
        expect.objectContaining({
          planId: 'plan-pro',
          planLevel: 'pro',
          billingCycle: 'monthly',
          allowed: false,
          action: 'none',
          reasonCode: 'CURRENT_PLAN',
        }),
        expect.objectContaining({
          planId: 'plan-pro',
          planLevel: 'pro',
          billingCycle: 'yearly',
          allowed: false,
          action: 'changeSubscriptionPlan',
          reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION',
        }),
        expect.objectContaining({
          planId: 'plan-gold',
          planLevel: 'gold',
          billingCycle: 'monthly',
          allowed: false,
          action: 'changeSubscriptionPlan',
          reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION',
        }),
      ]),
    });
  });

  it('returns service unavailable when eligibility facts resolve as READ_FAILED', async () => {
    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(Promise.resolve({
            data: {
              id: 'user-1',
              role: 'user',
              status: 'active',
              nickname: 'User',
              email: 'user@example.com',
              membership_level: 'free',
            },
            error: null,
          }));
        }

        if (table === 'membership_plans') {
          return createAwaitableQueryBuilder(Promise.resolve({
            data: [{ id: 'plan-pro', level: 'pro', is_active: 'true' }],
            error: null,
          }));
        }

        if (table === 'user_subscriptions') {
          return createMaybeSingleQueryBuilder(Promise.resolve({
            data: null,
            error: { code: '42501' },
          }));
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected matrix table ${table}`);
      },
    };

    const caller = createProtectedCaller({ supabase: userSupabase });

    await expect(caller.getMembershipEligibilityMatrix()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '会员状态暂不可用，请稍后重试',
    });
  });

  it.each(['profiles', 'membership_plans'])(
    'returns service unavailable when the %s matrix read rejects',
    async (rejectedTable) => {
      let profileReadCount = 0;
      const userSupabase = {
        from(table: string) {
          if (table === 'profiles') {
            const validProfile = Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
                membership_level: 'free',
              },
              error: null,
            });
            const result = rejectedTable === table && profileReadCount > 0
              ? Promise.reject(new Error('network unavailable'))
              : validProfile;
            profileReadCount += 1;
            return createSingleQueryBuilder(result);
          }

          if (table === 'membership_plans') {
            return createAwaitableQueryBuilder(
              rejectedTable === table
                ? Promise.reject(new Error('network unavailable'))
                : Promise.resolve({ data: [], error: null }),
            );
          }

          throw new Error(`Unexpected matrix table ${table}`);
        },
      };

      const caller = createProtectedCaller({ supabase: userSupabase });

      await expect(caller.getMembershipEligibilityMatrix()).rejects.toMatchObject<Partial<TRPCError>>({
        code: 'SERVICE_UNAVAILABLE',
        message: '会员状态暂不可用，请稍后重试',
      });
    },
  );

  it('creates membership checkout for a free user with no active subscription', async () => {
    const sessionCreate = vi.fn().mockResolvedValue({
      id: 'cs_test_membership',
      url: 'https://checkout.stripe.com/c/pay/cs_test_membership',
      payment_status: 'unpaid',
      subscription: 'sub_test_membership',
    });
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'free',
              },
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174222',
                name: 'Gold',
                level: 'gold',
                is_active: 'true',
                stripe_monthly_price_id: 'price_test_gold_monthly',
                stripe_yearly_price_id: 'price_test_gold_yearly',
                monthly_price: 2990,
                yearly_price: 29900,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions' || table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'membership_plan',
        planId: '123e4567-e89b-42d3-a456-426614174222',
        billingCycle: 'yearly',
      }),
    ).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_membership',
      sessionId: 'cs_test_membership',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(orderInserts[0]).toMatchObject({
      user_id: 'user-1',
      item_type: 'membership_plan',
      item_id: '123e4567-e89b-42d3-a456-426614174222',
      billing_cycle: 'yearly',
      amount_total: 29900,
    });
  });

  it('creates membership checkout for a free user with a stale admin override marker', async () => {
    const sessionCreate = vi.fn().mockResolvedValue({
      id: 'cs_test_stale_admin_override',
      url: 'https://checkout.stripe.com/c/pay/cs_test_stale_admin_override',
      payment_status: 'unpaid',
      subscription: 'sub_test_stale_admin_override',
    });
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'free',
              },
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174555',
                name: 'Pro',
                level: 'pro',
                is_active: 'true',
                stripe_monthly_price_id: 'price_test_pro_monthly',
                stripe_yearly_price_id: 'price_test_pro_yearly',
                monthly_price: 990,
                yearly_price: 9900,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'sub-row-admin-override',
                status: 'admin_override',
                metadata: { adminOverride: { adminId: 'admin-1' } },
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'membership_plan',
        planId: '123e4567-e89b-42d3-a456-426614174555',
        billingCycle: 'monthly',
      }),
    ).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_stale_admin_override',
      sessionId: 'cs_test_stale_admin_override',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(orderInserts[0]).toMatchObject({
      user_id: 'user-1',
      item_type: 'membership_plan',
      item_id: '123e4567-e89b-42d3-a456-426614174555',
      billing_cycle: 'monthly',
      amount_total: 990,
    });
  });

  it('rejects unsupported target membership levels before Stripe customer lookup, session creation, or order insert', async () => {
    const sessionCreate = vi.fn();
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'free',
              },
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174444',
                name: 'Legacy',
                level: 'legacy_platinum',
                is_active: 'true',
                stripe_monthly_price_id: 'price_test_legacy_monthly',
                stripe_yearly_price_id: 'price_test_legacy_yearly',
                monthly_price: 4990,
                yearly_price: 49900,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions' || table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(Promise.resolve({ data: null, error: null }));
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'membership_plan',
        planId: '123e4567-e89b-42d3-a456-426614174444',
        billingCycle: 'monthly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '目标会员等级暂不支持，请联系管理员处理后再操作。',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(orderInserts).toHaveLength(0);
  });

  it('fails closed for payment-status-refunded membership conflicts before Stripe session creation or order insert', async () => {
    const sessionCreate = vi.fn();
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'pro',
              },
              error: null,
            }),
          );
        }

        if (table === 'membership_plans') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: '123e4567-e89b-42d3-a456-426614174333',
                name: 'Gold',
                level: 'gold',
                is_active: 'true',
                stripe_monthly_price_id: 'price_test_gold_monthly',
                stripe_yearly_price_id: 'price_test_gold_yearly',
                monthly_price: 2990,
                yearly_price: 29900,
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'sub-row-1',
                stripe_subscription_id: 'sub_test_canceled',
                status: 'canceled',
                metadata: {},
              },
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'order-1',
                status: 'completed',
                payment_status: 'refunded',
                metadata: {},
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.createCheckoutSession({
        kind: 'membership_plan',
        planId: '123e4567-e89b-42d3-a456-426614174333',
        billingCycle: 'monthly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '该会员订单存在退款状态，需要人工确认后再操作。',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(orderInserts).toHaveLength(0);
  });

  it('syncs a paid subscription checkout session through membership fulfillment', async () => {
    const paidInvoice = {
      id: 'in_test_sync_paid',
      status: 'paid',
      amount_paid: 990,
      currency: 'usd',
      customer: 'cus_test_sync',
      parent: {
        subscription_details: {
          subscription: 'sub_test_sync',
        },
      },
    };
    const subscription = {
      id: 'sub_test_sync',
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [
          {
            current_period_start: 1_742_646_400,
            current_period_end: 1_745_238_400,
          },
        ],
      },
    };
    const session = {
      id: 'cs_test_sync_subscription',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-1',
      metadata: {
        userId: 'user-1',
        itemType: 'membership_plan',
        itemId: 'plan-1',
        billingCycle: 'monthly',
        priceId: 'price_test_monthly',
      },
      customer: 'cus_test_sync',
      subscription,
      invoice: paidInvoice,
    };

    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
    });
    vi.mocked(upsertPaymentOrderBySession).mockImplementation(async (_db, session) => session);
    vi.mocked(fulfillPaidMembershipCheckoutSession).mockResolvedValue({
      fulfilled: true,
      reason: null,
      invoiceId: 'in_test_sync_paid',
      subscriptionId: 'sub_test_sync',
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                status: 'completed',
                  id: 'sync-order-1', price_ref_id: 'price-ref-sync-order-1',
                  payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test',
                  subscription_id: 'sub-ref-sub_test_sync',
                payment_status: 'paid',
                fulfilled_at: '2026-05-22T16:10:00.000Z',
                stripe_subscription_id: 'sub_test_sync',
                stripe_invoice_id: 'in_test_sync_paid',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };
    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.syncCheckoutSession({ sessionId: 'cs_test_sync_subscription' }),
    ).resolves.toEqual({
      sessionId: 'cs_test_sync_subscription',
      mode: 'subscription',
      checkoutStatus: 'complete',
      paymentStatus: 'paid',
      orderStatus: 'completed',
      fulfilledAt: '2026-05-22T16:10:00.000Z',
      stripeSubscriptionId: 'sub_test_sync',
      stripeInvoiceId: 'in_test_sync_paid',
    });

    expect(upsertPaymentOrderBySession).toHaveBeenCalledWith(adminSupabase, session, {
      eventType: 'checkout.session.sync',
    });
    expect(fulfillPaidMembershipCheckoutSession).toHaveBeenCalledWith(
      adminSupabase,
      expect.objectContaining({
        checkout: expect.any(Object),
        invoices: expect.any(Object),
        subscriptions: expect.any(Object),
      }),
      session,
    );
    expect(syncSubscriptionState).not.toHaveBeenCalled();
    expect(fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(loggerState.info).toHaveBeenCalledWith(
      'billing',
      'payments_sync_checkout_stage',
      expect.objectContaining({
        stage: 'fulfill_membership_invoice',
        checkoutSessionId: 'cs_test_...iption',
        subscriptionId: 'sub_test...t_sync',
        invoiceId: 'in_test_...c_paid',
      }),
    );
  });

  it('returns deterministic sync state when duplicate checkout payment orders already exist', async () => {
    const session = {
      id: 'cs_test_sync_duplicate_orders',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-1',
      metadata: {
        userId: 'user-1',
        itemType: 'membership_plan',
        itemId: 'plan-1',
        billingCycle: 'yearly',
        priceId: 'price_test_yearly',
      },
      subscription: {
        id: 'sub_test_sync_duplicate',
      },
      invoice: {
        id: 'in_test_sync_duplicate',
        status: 'paid',
      },
    };
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
      invoices: {},
      subscriptions: {},
    });
    vi.mocked(upsertPaymentOrderBySession).mockImplementation(async (_db, session) => session);
    vi.mocked(fulfillPaidMembershipCheckoutSession).mockResolvedValue({
      fulfilled: true,
      reason: null,
      invoiceId: 'in_test_sync_duplicate',
      subscriptionId: 'sub_test_sync_duplicate',
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [
                {
                  status: 'completed',
                  id: 'sync-order-1', price_ref_id: 'price-ref-sync-order-1',
                  payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test',
                  subscription_id: 'sub-ref-sub_test_sync_duplicate',
                  payment_status: 'paid',
                  fulfilled_at: '2026-07-04T00:00:02.000Z',
                  stripe_subscription_id: 'sub_test_sync_duplicate',
                  stripe_invoice_id: 'in_test_sync_duplicate',
                },
                {
                  status: 'completed',
                  id: 'sync-order-2', price_ref_id: 'price-ref-sync-order-2',
                  payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test',
                  subscription_id: 'sub-ref-sub_test_sync_duplicate',
                  payment_status: 'paid',
                  fulfilled_at: '2026-07-04T00:00:03.000Z',
                  stripe_subscription_id: 'sub_test_sync_duplicate',
                  stripe_invoice_id: 'in_test_sync_duplicate',
                },
              ],
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };
    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.syncCheckoutSession({ sessionId: 'cs_test_sync_duplicate_orders' }),
    ).resolves.toEqual({
      sessionId: 'cs_test_sync_duplicate_orders',
      mode: 'subscription',
      checkoutStatus: 'complete',
      paymentStatus: 'paid',
      orderStatus: 'completed',
      fulfilledAt: '2026-07-04T00:00:02.000Z',
      stripeSubscriptionId: 'sub_test_sync_duplicate',
      stripeInvoiceId: 'in_test_sync_duplicate',
    });
    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'payments_sync_checkout_duplicate_order_detected',
      expect.objectContaining({
        checkoutSessionId: 'cs_test_...orders',
        orderCount: 2,
      }),
    );
  });

  it('does not silently accept an unfulfilled paid subscription checkout sync', async () => {
    const session = {
      id: 'cs_test_unfulfilled_paid_subscription',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-1',
      metadata: {
        userId: 'user-1',
        itemType: 'membership_plan',
        itemId: 'plan-1',
        billingCycle: 'yearly',
        priceId: 'price_test_yearly',
      },
      customer: 'cus_test_sync',
      subscription: 'sub_test_unfulfilled_paid_subscription',
      invoice: null,
    };

    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
    });
    vi.mocked(upsertPaymentOrderBySession).mockImplementation(async (_db, session) => session);
    vi.mocked(fulfillPaidMembershipCheckoutSession).mockResolvedValue({
      fulfilled: false,
      reason: 'paid_invoice_missing',
      invoiceId: null,
      subscriptionId: 'sub_test_unfulfilled_paid_subscription',
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: {
        from(table: string) {
          throw new Error(`Unexpected admin table ${table}`);
        },
      },
    });

    await expect(
      caller.syncCheckoutSession({ sessionId: 'cs_test_unfulfilled_paid_subscription' }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '同步支付会话失败，请稍后重试',
    });

    expect(loggerState.warn).toHaveBeenCalledWith(
      'billing',
      'payments_sync_checkout_unfulfilled_paid_subscription',
      expect.objectContaining({
        stage: 'fulfill_paid_membership_checkout_session',
        checkoutSessionId: 'cs_test_...iption',
        subscriptionId: 'sub_test...iption',
        reason: 'paid_invoice_missing',
      }),
    );
    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'payments_sync_checkout_stage_failed',
      expect.objectContaining({
        stage: 'fulfill_paid_membership_checkout_session',
        checkoutSessionId: 'cs_test_...iption',
      }),
    );
  });

  it('records a canceled checkout return without attempting fulfillment', async () => {
    const session = {
      id: 'cs_test_canceled_return',
      mode: 'payment',
      status: 'open',
      payment_status: 'unpaid',
      client_reference_id: 'user-1',
      metadata: {
        userId: 'user-1',
        itemType: 'credit_package',
        itemId: 'package-1',
        billingCycle: 'one_time',
        priceId: 'price_test_package',
      },
      customer: 'cus_test_canceled',
    };

    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
    });
    vi.mocked(upsertPaymentOrderBySession).mockImplementation(async (_db, session) => session);
    vi.mocked(fulfillMembershipInvoice).mockResolvedValue(undefined);
    vi.mocked(syncSubscriptionState).mockResolvedValue(undefined);

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                status: 'canceled',
                  id: 'sync-order-1', price_ref_id: 'price-ref-sync-order-1',
                  payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test',
                  subscription_id: null,
                payment_status: 'unpaid',
                fulfilled_at: null,
                stripe_subscription_id: null,
                stripe_invoice_id: null,
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };
    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.syncCheckoutSession({
        sessionId: 'cs_test_canceled_return',
        checkoutState: 'canceled',
      }),
    ).resolves.toEqual({
      sessionId: 'cs_test_canceled_return',
      mode: 'payment',
      checkoutStatus: 'open',
      paymentStatus: 'unpaid',
      orderStatus: 'canceled',
      fulfilledAt: null,
      stripeSubscriptionId: null,
      stripeInvoiceId: null,
    });

    expect(upsertPaymentOrderBySession).toHaveBeenCalledWith(adminSupabase, session, {
      orderStatus: 'canceled',
      eventType: 'checkout.return.canceled',
    });
    expect(fulfillPaidMembershipCheckoutSession).not.toHaveBeenCalled();
    expect(fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(syncSubscriptionState).not.toHaveBeenCalled();
  });

  it.each([
    'paid_invoice_missing',
    'paid_invoice_unpaid',
  ])('preserves existing blocked invoice audit for %s when router catch records context', async (blockedReason) => {
    const session = {
      id: `cs_test_blocked_${blockedReason}`,
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-1',
      metadata: {
        userId: 'user-1',
        itemType: 'membership_plan',
        itemId: 'plan-1',
        billingCycle: 'yearly',
        priceId: 'price_test_yearly',
      },
      customer: 'cus_test_blocked_invoice',
      subscription: `sub_test_blocked_${blockedReason}`,
      invoice: null,
    };
    const existingInvoiceResolutionAudit = {
      sessionInvoicePresent: blockedReason === 'paid_invoice_unpaid',
      sessionInvoiceId: 'in_test...locked',
      sessionInvoiceStatus: blockedReason === 'paid_invoice_unpaid' ? 'open' : null,
      latestInvoicePresent: false,
      latestInvoiceId: null,
      latestInvoiceStatus: null,
      invoiceListCount: 99,
      invoiceListStatuses: blockedReason === 'paid_invoice_unpaid' ? ['open'] : [],
      paidInvoiceFound: false,
      reason: blockedReason,
    };

    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
    });
    vi.mocked(upsertPaymentOrderBySession).mockImplementation(async (_db, session) => session);
    vi.mocked(fulfillPaidMembershipCheckoutSession).mockRejectedValue(
      Object.assign(new Error(`invoice audit already blocked for user@example.com ${session.id}`), {
        stage: 'checkout_paid_invoice_resolution',
        safeContext: {
          reason: blockedReason,
          sessionInvoiceId: 'in_test_...newer',
          sessionInvoiceStatus: 'paid',
          latestInvoiceId: 'in_test_...newer',
          latestInvoiceStatus: 'paid',
          invoiceListCount: 1,
          invoiceListStatuses: ['paid'],
        },
      }),
    );

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const paymentOrderUpdates: Array<Record<string, any>> = [];
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: {
                  id: `order-blocked-${blockedReason}`,
                  metadata: {
                    source: 'checkout.session.sync',
                    invoiceResolutionAudit: existingInvoiceResolutionAudit,
                    syncCheckoutSessionFulfillment: {
                      status: 'blocked',
                      stage: 'checkout_paid_invoice_resolution',
                      reason: blockedReason,
                      checkoutStatus: 'complete',
                      paymentStatus: 'paid',
                      subscriptionId: 'sub_test...locked',
                      invoiceResolutionAudit: existingInvoiceResolutionAudit,
                      updatedAt: '2026-07-01T00:00:00.000Z',
                    },
                    lastFulfillmentError: {
                      stage: 'checkout_paid_invoice_resolution',
                      reason: blockedReason,
                      updatedAt: '2026-07-01T00:00:00.000Z',
                    },
                  },
                },
                error: null,
              });
            },
            update(payload: Record<string, any>) {
              paymentOrderUpdates.push(payload);
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };
    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.syncCheckoutSession({ sessionId: session.id }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '同步支付会话失败，请稍后重试',
    });

    expect(paymentOrderUpdates).toHaveLength(1);
    expect(paymentOrderUpdates[0].metadata).toMatchObject({
      source: 'checkout.session.sync',
      invoiceResolutionAudit: existingInvoiceResolutionAudit,
      syncCheckoutSessionFulfillment: expect.objectContaining({
        status: 'blocked',
        stage: 'checkout_paid_invoice_resolution',
        reason: blockedReason,
        invoiceResolutionAudit: existingInvoiceResolutionAudit,
      }),
      lastFulfillmentError: expect.objectContaining({
        stage: 'checkout_paid_invoice_resolution',
        reason: blockedReason,
        routerCatch: expect.objectContaining({
          stage: 'fulfill_paid_membership_checkout_session',
          reason: 'checkout_paid_invoice_resolution',
          errorStage: 'checkout_paid_invoice_resolution',
          message: expect.stringContaining('[masked-email]'),
        }),
      }),
    });
    expect(paymentOrderUpdates[0].metadata.syncCheckoutSessionFulfillment).not.toMatchObject({
      status: 'failed',
    });
    const metadataJson = JSON.stringify(paymentOrderUpdates[0].metadata);
    expect(metadataJson).not.toContain(session.id);
    expect(metadataJson).not.toContain(`sub_test_blocked_${blockedReason}`);
    expect(metadataJson).not.toContain('in_test_blocked');
    expect(metadataJson).not.toContain('cus_test_blocked_invoice');
    expect(metadataJson).not.toContain('user@example.com');
    expect(metadataJson).not.toContain('payment_method');
  });

  it('logs the failing sync stage while returning a safe frontend message', async () => {
    const paidInvoice = {
      id: 'in_test_rpc_failure',
      status: 'paid',
      amount_paid: 990,
      currency: 'usd',
      customer: 'cus_test_sync',
      parent: {
        subscription_details: {
          subscription: 'sub_test_rpc_failure',
        },
      },
    };
    const subscription = {
      id: 'sub_test_rpc_failure',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [] },
    };
    const session = {
      id: 'cs_test_sync_rpc_failure',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: 'user-1',
      metadata: {
        userId: 'user-1',
        itemType: 'membership_plan',
        itemId: 'plan-1',
        billingCycle: 'monthly',
        priceId: 'price_test_monthly',
      },
      customer: 'cus_test_sync',
      subscription,
      invoice: paidInvoice,
    };

    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue(session),
        },
      },
      invoices: {
        retrieve: vi.fn(),
        list: vi.fn(),
      },
      subscriptions: {
        retrieve: vi.fn(),
      },
    });
    vi.mocked(upsertPaymentOrderBySession).mockImplementation(async (_db, session) => session);
    vi.mocked(fulfillPaidMembershipCheckoutSession).mockRejectedValue(
      Object.assign(new Error('Failed to fulfill membership invoice for user@example.com in cs_test_sync_rpc_failure'), {
        stage: 'fulfill_membership_invoice_rpc',
        safeContext: {
          sessionInvoiceId: 'in_test_...ailure',
          sessionInvoiceStatus: 'paid',
          latestInvoiceId: 'in_test_...ailure',
          latestInvoiceStatus: 'paid',
          invoiceListCount: 1,
          invoiceListStatuses: ['paid'],
          reason: 'membership_invoice_fulfillment_failed',
          invoiceId: 'in_test_...ailure',
          subscriptionId: 'sub_test...ailure',
          supabaseError: { code: 'P0001', message: 'subscription order not found' },
        },
      }),
    );

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected user table ${table}`);
      },
    };
    const paymentOrderUpdates: Array<Record<string, any>> = [];
    const adminSupabase = {
      from(table: string) {
        if (table === 'payment_orders') {
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: {
                  id: 'order-sync-rpc-failure',
                  metadata: {
                    source: 'checkout.session.sync',
                  },
                },
                error: null,
              });
            },
            update(payload: Record<string, any>) {
              paymentOrderUpdates.push(payload);
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };
    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.syncCheckoutSession({ sessionId: 'cs_test_sync_rpc_failure' }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '同步支付会话失败，请稍后重试',
    });

    expect(loggerState.error).toHaveBeenCalledWith(
      'billing',
      'payments_sync_checkout_stage_failed',
      expect.objectContaining({
        stage: 'fulfill_paid_membership_checkout_session',
        checkoutSessionId: 'cs_test_...ailure',
        error: expect.objectContaining({
          stage: 'fulfill_membership_invoice_rpc',
          safeContext: expect.objectContaining({
            invoiceId: 'in_test_...ailure',
            subscriptionId: 'sub_test...ailure',
          }),
        }),
      }),
    );
    expect(paymentOrderUpdates).toHaveLength(1);
    expect(paymentOrderUpdates[0].metadata).toMatchObject({
      source: 'checkout.session.sync',
      invoiceResolutionAudit: expect.objectContaining({
        sessionInvoicePresent: true,
        sessionInvoiceStatus: 'paid',
        latestInvoicePresent: true,
        latestInvoiceStatus: 'paid',
        invoiceListCount: 1,
        invoiceListStatuses: ['paid'],
        paidInvoiceFound: false,
        reason: 'membership_invoice_fulfillment_failed',
      }),
      syncCheckoutSessionFulfillment: expect.objectContaining({
        status: 'failed',
        stage: 'fulfill_paid_membership_checkout_session',
        reason: 'fulfill_membership_invoice_rpc',
        checkoutStatus: 'complete',
        paymentStatus: 'paid',
        subscriptionId: 'sub_test...ailure',
        invoiceId: 'in_test_...ailure',
      }),
      lastFulfillmentError: expect.objectContaining({
        stage: 'fulfill_paid_membership_checkout_session',
        reason: 'fulfill_membership_invoice_rpc',
        errorStage: 'fulfill_membership_invoice_rpc',
        message: expect.stringContaining('[masked-email]'),
      }),
    });
    const metadataJson = JSON.stringify(paymentOrderUpdates[0].metadata);
    expect(metadataJson).not.toContain('cs_test_sync_rpc_failure');
    expect(metadataJson).not.toContain('sub_test_rpc_failure');
    expect(metadataJson).not.toContain('in_test_rpc_failure');
    expect(metadataJson).not.toContain('cus_test_sync');
    expect(metadataJson).not.toContain('user@example.com');
  });
});

describe('createCheckoutSession catalog fail-closed guards', () => {
  const packageId = '123e4567-e89b-42d3-a456-426614174000';
  const planId = '123e4567-e89b-42d3-a456-426614174111';

  beforeEach(() => {
    stripeState.assertCheckoutRateLimit.mockReset();
    stripeState.assertSubscriptionChangeRateLimit.mockReset();
    stripeState.getStripePortalReturnUrl.mockReset().mockReturnValue('https://app.example.com/profile?tab=subscription');
    stripeState.assertStripeCheckoutConfigured.mockReset();
    stripeState.getOrCreateStripeCustomerId.mockReset().mockResolvedValue('cus_test_guard');
    stripeState.getStripeAppUrl.mockReset().mockReturnValue('http://localhost:3000');
    stripeState.getStripeClient.mockReset();
    stripeState.buildStripeMetadata.mockReset().mockReturnValue({});
    stripeState.calculateDiscountedAmountCents.mockReset().mockReturnValue({
      baseAmountCents: 1000,
      discountedAmountCents: 1000,
      normalizedDiscount: 100,
    });
  });

  function createGuardHarness(options: {
    kind: 'credit_package' | 'membership_plan';
    profileResult?: Promise<unknown>;
    profileResults?: Promise<unknown>[];
    itemResult?: Promise<unknown>;
    factsResult?: Promise<unknown>;
    alipaySubscriptionEnabled?: boolean;
  }) {
    const sessionCreate = vi.fn();
    const orderInserts: unknown[] = [];
    stripeState.getStripeClient.mockReturnValue({
      checkout: { sessions: { create: sessionCreate } },
    });

    const profileResult = options.profileResult ?? Promise.resolve({
      data: {
        email: 'user@example.com',
        nickname: 'User',
        membership_level: 'free',
      },
      error: null,
    });
    const itemResult = options.itemResult ?? Promise.resolve({
      data: options.kind === 'credit_package'
        ? {
            id: packageId,
            name: 'Credits',
            active: 'true',
            stripe_price_id: 'price_test_package',
            price: 1000,
          }
        : {
            id: planId,
            name: 'Pro',
            level: 'pro',
            is_active: 'true',
            stripe_monthly_price_id: 'price_test_monthly',
            stripe_yearly_price_id: 'price_test_yearly',
            monthly_price: 9900,
            yearly_price: 99900,
          },
      error: null,
    });
    const factsResult = options.factsResult
      ?? Promise.resolve({ data: null, error: null });
    let profileReadCount = 0;

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          const result = options.profileResults
            ? options.profileResults[Math.min(profileReadCount, options.profileResults.length - 1)]
            : profileResult;
          profileReadCount += 1;
          return createSingleQueryBuilder(result);
        }

        if (table === 'system_settings') return createSingleQueryBuilder(Promise.resolve({ data: { key: 'alipay_subscription_enabled', value: options.alipaySubscriptionEnabled ?? false }, error: null }));

        if (table === 'credit_packages' || table === 'membership_plans') {
          return createSingleQueryBuilder(itemResult);
        }

        if (table === 'user_subscriptions' || table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(factsResult);
        }

        throw new Error(`Unexpected guard table ${table}`);
      },
    };
    const supabaseAdmin = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(Promise.resolve({
            data: {
              id: 'user-1',
              role: 'user',
              status: 'active',
              email: 'user@example.com',
              nickname: 'User',
              membership_level: 'free',
            },
            error: null,
          }));
        }

        if (table === 'payment_orders') {
          return createInsertBuilder(Promise.resolve({ error: null }), orderInserts);
        }

        throw new Error(`Unexpected guard admin table ${table}`);
      },
    };

    return {
      caller: createProtectedCaller({ supabase, supabaseAdmin }),
      sessionCreate,
      orderInserts,
    };
  }

  it.each(['credit_package', 'membership_plan'] as const)('rejects limited %s requests before customer/session/order side effects', async (kind) => {
    const harness = createGuardHarness({ kind });
    stripeState.assertCheckoutRateLimit.mockRejectedValue(new TRPCError({ code: 'TOO_MANY_REQUESTS' }));
    const input = kind === 'credit_package' ? { kind, packageId } : { kind, planId, billingCycle: 'monthly' as const };
    await expect(harness.caller.createCheckoutSession(input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expectNoCheckoutWrites(harness);
  });

  it.each(['credit_package', 'membership_plan'] as const)('creates %s with the correct payment methods when within limit', async (kind) => {
    const harness = createGuardHarness({ kind });
    harness.sessionCreate.mockResolvedValue({ id: 'cs_test_pay1', url: 'https://checkout.stripe.com/test', payment_status: 'unpaid' });
    const input = kind === 'credit_package' ? { kind, packageId } : { kind, planId, billingCycle: 'monthly' as const };
    await expect(harness.caller.createCheckoutSession(input)).resolves.toMatchObject({ sessionId: 'cs_test_pay1' });
    expect(harness.sessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: kind === 'credit_package' ? 'payment' : 'subscription',
      payment_method_types: kind === 'credit_package' ? ['card', 'alipay'] : ['card'],
    }), { idempotencyKey: expect.stringContaining('checkout:') });
    expect(stripeState.assertCheckoutRateLimit).toHaveBeenCalledOnce();
    expect(stripeState.assertCheckoutRateLimit.mock.invocationCallOrder[0])
      .toBeLessThan(harness.sessionCreate.mock.invocationCallOrder[0]);
    expect(harness.orderInserts).toHaveLength(1);
  });

  it.each([
    ['PAY_COMMON_ATTEMPT_NOT_TERMINAL', 'CONFLICT', '原订单的付款结果尚未确认，请稍后重试或在账单中查看。'],
    ['PAY_COMMON_ATTEMPT_CLOSE_FAILED', 'CONFLICT', '原订单的付款结果尚未确认，请稍后重试或在账单中查看。'],
    ['PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH', 'CONFLICT', '原订单的付款信息不一致，请通过工单联系我们核对。'],
    ['PAY_COMMON_RECEIPT_MISMATCH', 'CONFLICT', '原订单的付款信息不一致，请通过工单联系我们核对。'],
    ['PAY_COMMON_ATTEMPT_EVIDENCE_UNAVAILABLE', 'SERVICE_UNAVAILABLE', '暂时无法核对原订单的付款结果，请稍后重试。'],
  ])('maps purchase recovery error %s to a safe actionable response', async (reason, code, message) => {
    const harness = createGuardHarness({ kind: 'credit_package' });
    harness.sessionCreate.mockRejectedValue(new Error(reason));
    await expect(harness.caller.createCheckoutSession({ kind: 'credit_package', packageId }))
      .rejects.toMatchObject({ code, message });
  });

  it.each([false, true])('keeps membership card-only with alipay_subscription_enabled=%s', async (enabled) => {
    const harness = createGuardHarness({ kind: 'membership_plan', alipaySubscriptionEnabled: enabled });
    harness.sessionCreate.mockResolvedValue({ id: 'cs_flag', url: 'https://checkout.stripe.com/test', payment_status: 'unpaid' });
    await harness.caller.createCheckoutSession({ kind: 'membership_plan', planId, billingCycle: 'yearly' });
    expect(harness.sessionCreate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'subscription', payment_method_types: ['card'] }), { idempotencyKey: expect.any(String) });
  });

  function expectNoCheckoutWrites(harness: {
    sessionCreate: ReturnType<typeof vi.fn>;
    orderInserts: unknown[];
  }) {
    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(harness.sessionCreate).not.toHaveBeenCalled();
    expect(harness.orderInserts).toHaveLength(0);
  }

  it.each([
    [
      'database error',
      () => Promise.resolve({ data: null, error: { code: '42501' } }),
      'SERVICE_UNAVAILABLE',
      '用户资料服务暂不可用，请稍后重试',
    ],
    [
      'network rejection',
      () => Promise.reject(new Error('network unavailable')),
      'SERVICE_UNAVAILABLE',
      '用户资料服务暂不可用，请稍后重试',
    ],
  ])('returns unavailable for a profile %s before Stripe or order writes', async (
    _caseName,
    createProfileResult,
    code,
    message,
  ) => {
    const failingResult = createProfileResult();
    const harness = createGuardHarness({
      kind: 'credit_package',
      profileResult: failingResult,
      profileResults: _caseName === 'network rejection'
        ? [
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'free',
              },
              error: null,
            }),
            failingResult,
          ]
        : undefined,
    });

    await expect(harness.caller.createCheckoutSession({
      kind: 'credit_package',
      packageId,
    })).rejects.toMatchObject<Partial<TRPCError>>({ code, message });
    expectNoCheckoutWrites(harness);
  });

  it('keeps successful profile not-found distinct from profile read failure', async () => {
    const harness = createGuardHarness({
      kind: 'credit_package',
      profileResult: Promise.resolve({ data: null, error: null }),
    });

    await expect(harness.caller.createCheckoutSession({
      kind: 'credit_package',
      packageId,
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'NOT_FOUND',
      message: '用户资料不存在，无法创建支付会话',
    });
    expectNoCheckoutWrites(harness);
  });

  it.each([
    ['database error', Promise.resolve({ data: null, error: { code: '57014' } }), 'SERVICE_UNAVAILABLE', '积分包服务暂不可用，请稍后重试'],
    ['successful not-found', Promise.resolve({ data: null, error: null }), 'NOT_FOUND', '积分包不存在'],
    ['inactive', Promise.resolve({ data: { id: packageId, name: 'Credits', active: 'false', stripe_price_id: 'price_test_package', price: 1000 }, error: null }), 'BAD_REQUEST', '该积分包当前未上架'],
    ['Price missing', Promise.resolve({ data: { id: packageId, name: 'Credits', active: 'true', stripe_price_id: null, price: 1000 }, error: null }), 'BAD_REQUEST', '该商品暂不可购买，请稍后重试'],
    ['Price blank', Promise.resolve({ data: { id: packageId, name: 'Credits', active: 'true', stripe_price_id: '   ', price: 1000 }, error: null }), 'BAD_REQUEST', '该商品暂不可购买，请稍后重试'],
    ['invalid amount', Promise.resolve({ data: { id: packageId, name: 'Credits', active: 'true', stripe_price_id: 'price_test_package', price: null }, error: null }), 'BAD_REQUEST', '该商品暂不可购买，请稍后重试'],
  ])('fails closed for credit package %s', async (_caseName, itemResult, code, message) => {
    const harness = createGuardHarness({ kind: 'credit_package', itemResult });

    await expect(harness.caller.createCheckoutSession({
      kind: 'credit_package',
      packageId,
    })).rejects.toMatchObject<Partial<TRPCError>>({ code, message });
    expectNoCheckoutWrites(harness);
  });

  it.each([
    ['database error', Promise.resolve({ data: null, error: { code: '42501' } }), 'SERVICE_UNAVAILABLE', '会员套餐服务暂不可用，请稍后重试'],
    ['successful not-found', Promise.resolve({ data: null, error: null }), 'NOT_FOUND', '会员套餐不存在'],
    ['inactive', Promise.resolve({ data: { id: planId, name: 'Pro', level: 'pro', is_active: 'false', stripe_monthly_price_id: 'price_test_monthly', stripe_yearly_price_id: 'price_test_yearly', monthly_price: 9900, yearly_price: 99900 }, error: null }), 'BAD_REQUEST', '该会员套餐当前未启用'],
    ['Price missing', Promise.resolve({ data: { id: planId, name: 'Pro', level: 'pro', is_active: 'true', stripe_monthly_price_id: null, stripe_yearly_price_id: 'price_test_yearly', monthly_price: 9900, yearly_price: 99900 }, error: null }), 'BAD_REQUEST', '该会员套餐暂不可购买，请稍后重试'],
    ['Price blank', Promise.resolve({ data: { id: planId, name: 'Pro', level: 'pro', is_active: 'true', stripe_monthly_price_id: '   ', stripe_yearly_price_id: 'price_test_yearly', monthly_price: 9900, yearly_price: 99900 }, error: null }), 'BAD_REQUEST', '该会员套餐暂不可购买，请稍后重试'],
    ['invalid amount', Promise.resolve({ data: { id: planId, name: 'Pro', level: 'pro', is_active: 'true', stripe_monthly_price_id: 'price_test_monthly', stripe_yearly_price_id: 'price_test_yearly', monthly_price: null, yearly_price: 99900 }, error: null }), 'BAD_REQUEST', '该会员套餐暂不可购买，请稍后重试'],
  ])('fails closed for membership plan %s', async (_caseName, itemResult, code, message) => {
    const harness = createGuardHarness({ kind: 'membership_plan', itemResult });

    await expect(harness.caller.createCheckoutSession({
      kind: 'membership_plan',
      planId,
      billingCycle: 'monthly',
    })).rejects.toMatchObject<Partial<TRPCError>>({ code, message });
    expectNoCheckoutWrites(harness);
  });

  it('fails closed for a blank yearly membership Price before Stripe or order writes', async () => {
    const harness = createGuardHarness({
      kind: 'membership_plan',
      itemResult: Promise.resolve({
        data: {
          id: planId,
          name: 'Pro',
          level: 'pro',
          is_active: 'true',
          stripe_monthly_price_id: 'price_test_monthly',
          stripe_yearly_price_id: '   ',
          monthly_price: 9900,
          yearly_price: 99900,
        },
        error: null,
      }),
    });

    await expect(harness.caller.createCheckoutSession({
      kind: 'membership_plan',
      planId,
      billingCycle: 'yearly',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '该会员套餐暂不可购买，请稍后重试',
    });
    expectNoCheckoutWrites(harness);
  });

  it.each(['credit_package', 'membership_plan'] as const)(
    'fails closed when the %s item read rejects',
    async (kind) => {
      const harness = createGuardHarness({
        kind,
        itemResult: Promise.reject(new Error('network unavailable')),
      });

      await expect(harness.caller.createCheckoutSession(
        kind === 'credit_package'
          ? { kind, packageId }
          : { kind, planId, billingCycle: 'monthly' },
      )).rejects.toMatchObject<Partial<TRPCError>>({
        code: 'SERVICE_UNAVAILABLE',
      });
      expectNoCheckoutWrites(harness);
    },
  );

  it('fails closed when eligibility facts cannot be read', async () => {
    const harness = createGuardHarness({
      kind: 'membership_plan',
      factsResult: Promise.resolve({ data: null, error: { code: '42501' } }),
    });

    await expect(harness.caller.createCheckoutSession({
      kind: 'membership_plan',
      planId,
      billingCycle: 'monthly',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '会员状态暂不可用，请稍后重试。',
    });
    expectNoCheckoutWrites(harness);
  });

  it('fails closed when eligibility facts reject', async () => {
    const harness = createGuardHarness({
      kind: 'membership_plan',
      factsResult: Promise.reject(new Error('network unavailable')),
    });

    await expect(harness.caller.createCheckoutSession({
      kind: 'membership_plan',
      planId,
      billingCycle: 'monthly',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '会员状态暂不可用，请稍后重试',
    });
    expectNoCheckoutWrites(harness);
  });
});

describe('PAY-1 Customer Portal', () => {
  function portalHarness(options: { noSubscription?: boolean; wrongCustomer?: boolean; immediateCancel?: boolean; upgrades?: boolean; scheduled?: boolean; readError?: boolean } = {}) {
    const create = vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/p/session/test' });
    const retrieve = vi.fn().mockResolvedValue({ id: 'sub_pay1', cancel_at: options.scheduled ? 2000000000 : null, customer: options.wrongCustomer ? 'cus_other' : 'cus_pay1', metadata: { userId: 'user-1' } });
    const filters: Array<[string, unknown]> = [];
    const supabase = { rpc: async () => { throw new Error('Unexpected Portal RPC'); },
      from(table: string) {
        if (table === 'profiles') return createSingleQueryBuilder(Promise.resolve({ data: { id: 'user-1', role: 'user', status: 'active', nickname: 'User', email: 'user@example.com' }, error: null }));
        if (table === 'payment_orders') {
          const row = { id: 'order-pay1', payment_channel: 'stripe', merchant_namespace: 'acct_fixture',
            payment_mode: 'test', price_ref_id: 'price-ref-pay1', subscription_id: 'mirror_pay1' };
          const builder = { select: () => builder, eq: () => builder, not: () => builder, order: () => builder,
            limit: () => builder, maybeSingle: async () => ({ data: row, error: null }) };
          return builder;
        }
        if (table === 'subscription_credit_grants') {
          const builder = { select: () => builder, eq: () => builder,
            limit: async () => ({ data: [{ source_order_id: 'order-pay1' }], error: null }) };
          return builder;
        }
        if (table === 'payment_provider_refs') {
          const refs = [ { id: 'price-ref-pay1', object_type: 'price', external_id: 'price_pay1' },
            { subscription_id: 'mirror_pay1', object_type: 'subscription', external_id: 'sub_pay1' } ]
            .map(ref => ({ ...ref, channel: 'stripe', merchant_namespace: 'acct_fixture', mode: 'test' }));
          const selected: Array<[string, unknown]> = [];
          const result = () => ({ data: refs.filter(row => selected.every(([key, value]) => (row as Record<string, unknown>)[key] === value)), error: null });
          const builder = { select: () => builder, eq: (key: string, value: unknown) => { selected.push([key, value]); return builder; },
            limit: () => builder, maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
            then: <T>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve) };
          return builder;
        }
        if (table !== 'user_subscriptions') throw new Error(`unexpected table ${table}`);
        const builder = {
          select: () => builder, not: () => builder, order: () => builder, in: () => builder,
          eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
          limit: async () => ({ data: options.noSubscription ? [] : [{ id: 'mirror_pay1', payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test', status: 'active', membership_plan_id: 'plan-pay1', billing_cycle: 'monthly', current_period_start: '2026-01-01T00:00:00Z', stripe_customer_id: 'cus_pay1', stripe_subscription_id: 'sub_pay1' }], error: options.readError ? { message: 'db failed' } : null }),
        };
        return builder;
      },
    };
    stripeState.getStripeClient.mockReturnValue({ subscriptions: { retrieve }, billingPortal: {
      sessions: { create }, configurations: { list: vi.fn().mockResolvedValue({ data: [{ id: 'bpc_pay1', active: true, features: {
        subscription_cancel: { enabled: true, mode: options.immediateCancel ? 'immediately' : 'at_period_end' },
        subscription_update: { enabled: options.upgrades ?? false },
      } }] }) },
    } });
    return { caller: createProtectedCaller({ supabase }), supabase, create, retrieve, filters };
  }
  beforeEach(() => {
    stripeState.getStripePortalReturnUrl.mockReset().mockReturnValue('https://app.example.com/profile?tab=subscription');
    stripeState.getStripeClient.mockReset();
  });
  it('opens Portal home for explicit renewal restoration on scheduled cancellations', async () => {
    const h = portalHarness({ scheduled: true });
    await h.caller.createCustomerPortalSession({});
    expect(h.create.mock.calls[0][0].flow_data).toBeUndefined();
    expect(h.create.mock.calls[0][0].customer).toBe('cus_pay1');
  });
  it.each([false, true])('reports Portal availability independently of catalog state (missing subscription=%s)', async (noSubscription) => {
    const h = portalHarness({ noSubscription });
    await expect(h.caller.getSubscriptionManagement()).resolves.toEqual({ available: !noSubscription });
    expect(h.create).not.toHaveBeenCalled();
  });
  it('server-resolves the authenticated customer and creates only a period-end cancellation flow', async () => {
    const h = portalHarness();
    await expect(h.caller.createCustomerPortalSession({})).resolves.toEqual({ portalUrl: 'https://billing.stripe.com/p/session/test' });
    expect(h.filters).toContainEqual(['user_id', 'user-1']);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_pay1', configuration: 'bpc_pay1', return_url: 'https://app.example.com/profile?tab=subscription', flow_data: expect.objectContaining({ type: 'subscription_cancel', subscription_cancel: { subscription: 'sub_pay1' } }) }));
  });
  it.each([{ noSubscription: true }, { wrongCustomer: true }, { immediateCancel: true }, { upgrades: true }, { readError: true }])('denies an unsafe Portal state %j before session creation', async (options) => {
    const h = portalHarness(options);
    await expect(h.caller.createCustomerPortalSession({})).rejects.toBeInstanceOf(TRPCError);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('rejects arbitrary client customer IDs', async () => {
    const h = portalHarness();
    await expect(h.caller.createCustomerPortalSession({ customerId: 'cus_victim' } as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
  });
  it('rejects return URL abuse before Stripe calls', async () => {
    const h = portalHarness();
    stripeState.getStripePortalReturnUrl.mockImplementation(() => { throw new TRPCError({ code: 'BAD_REQUEST' }); });
    await expect(h.caller.createCustomerPortalSession({ returnUrl: 'https://evil.example' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    const h = portalHarness();
    const caller = paymentsRouter.createCaller({ user: null, headers: new Headers(), supabase: h.supabase } as any);
    await expect(caller.createCustomerPortalSession({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.create).not.toHaveBeenCalled();
  });
});
