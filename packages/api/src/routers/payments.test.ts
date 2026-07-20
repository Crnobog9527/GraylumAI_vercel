import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stripeState = vi.hoisted(() => ({
  assertStripeCheckoutConfigured: vi.fn(),
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
  buildStripeMetadata: stripeState.buildStripeMetadata,
  calculateDiscountedAmountCents: stripeState.calculateDiscountedAmountCents,
  getOrCreateStripeCustomerId: stripeState.getOrCreateStripeCustomerId,
  getStripeAppUrl: stripeState.getStripeAppUrl,
  getStripeClient: stripeState.getStripeClient,
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

function createProtectedCaller(options: {
  supabase: {
    from(table: string): unknown;
  };
  supabaseAdmin?: {
    from(table: string): unknown;
  };
}) {
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

describe('paymentsRouter error sanitization', () => {
  beforeEach(() => {
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
    vi.mocked(upsertPaymentOrderBySession).mockReset();
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

  it('uses the service-role client for checkout customer lookup and order insert', async () => {
    const sessionCreate = vi.fn().mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      payment_status: 'paid',
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

    expect(stripeState.getOrCreateStripeCustomerId).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase: adminSupabase,
        userId: 'user-1',
      }),
    );
    expect(orderInserts).toHaveLength(1);
    expect(orderInserts[0]).toMatchObject({
      user_id: 'user-1',
      item_type: 'credit_package',
      item_id: '123e4567-e89b-42d3-a456-426614174000',
      status: 'pending',
      payment_status: 'paid',
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
      message: '当前会员订阅仍有效，升级套餐需要通过 changeSubscriptionPlan 处理；该能力将在 PR5 实现，本次不会创建新的 Checkout。',
    });

    expect(stripeState.getOrCreateStripeCustomerId).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(orderInserts).toHaveLength(0);
  });

  it('changes an eligible active subscription plan without creating checkout or credit grants', async () => {
    const subscriptionRetrieve = vi.fn().mockResolvedValue({
      id: 'sub_test_active',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { userId: 'user-1' },
      items: {
        data: [
          {
            id: 'si_test_current',
            current_period_start: 1_742_646_400,
            current_period_end: 1_745_238_400,
          },
        ],
      },
    });
    const updatedSubscription = {
      id: 'sub_test_active',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { userId: 'user-1' },
      items: {
        data: [
          {
            id: 'si_test_current',
            current_period_start: 1_742_646_400,
            current_period_end: 1_745_238_400,
          },
        ],
      },
    };
    const subscriptionUpdate = vi.fn().mockResolvedValue(updatedSubscription);
    const sessionCreate = vi.fn();
    const orderInserts: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    stripeState.buildStripeMetadata.mockReturnValue({
      itemType: 'membership_plan',
      itemId: '123e4567-e89b-42d3-a456-426614174222',
      userId: 'user-1',
      priceId: 'price_test_gold_yearly',
      billingCycle: 'yearly',
    });
    stripeState.getStripeClient.mockReturnValue({
      checkout: {
        sessions: {
          create: sessionCreate,
        },
      },
      subscriptions: {
        retrieve: subscriptionRetrieve,
        update: subscriptionUpdate,
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
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [{
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                stripe_customer_id: 'cus_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
                metadata: {},
              }],
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

        if (table === 'user_subscriptions') {
          return createUpdateBuilder(Promise.resolve({ error: null }), subscriptionUpdates);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.changeSubscriptionPlan({
        planId: '123e4567-e89b-42d3-a456-426614174222',
        billingCycle: 'yearly',
      }),
    ).resolves.toMatchObject({
      subscriptionId: 'sub_test_active',
      status: 'active',
      planId: '123e4567-e89b-42d3-a456-426614174222',
      planLevel: 'gold',
      billingCycle: 'yearly',
      action: 'changeSubscriptionPlan',
    });

    expect(sessionCreate).not.toHaveBeenCalled();
    expect(fulfillMembershipInvoice).not.toHaveBeenCalled();
    expect(subscriptionRetrieve).toHaveBeenCalledWith('sub_test_active');
    expect(subscriptionUpdate).toHaveBeenCalledWith('sub_test_active', expect.objectContaining({
      items: [{ id: 'si_test_current', price: 'price_test_gold_yearly' }],
      proration_behavior: 'always_invoice',
      cancel_at_period_end: false,
    }));
    expect(syncSubscriptionState).toHaveBeenCalledWith(adminSupabase, updatedSubscription);
    expect(subscriptionUpdates).toHaveLength(0);
    expect(orderInserts).toHaveLength(1);
    expect(orderInserts[0]).toMatchObject({
      user_id: 'user-1',
      item_type: 'membership_plan',
      item_id: '123e4567-e89b-42d3-a456-426614174222',
      billing_cycle: 'yearly',
      stripe_subscription_id: 'sub_test_active',
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_test_active',
      stripe_customer_id: 'cus_test_active',
      stripe_price_id: 'price_test_gold_yearly',
      amount_total: null,
      mode: 'subscription',
      status: 'pending',
      payment_status: 'active',
      metadata: expect.objectContaining({
        source: 'changeSubscriptionPlan',
        previousMembershipPlanId: '123e4567-e89b-42d3-a456-426614174111',
        previousBillingCycle: 'monthly',
      }),
    });
  });

  it('rejects concurrent plan-change lock conflicts before Stripe subscription update', async () => {
    const subscriptionRetrieve = vi.fn().mockResolvedValue({
      id: 'sub_test_active',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { userId: 'user-1' },
      items: {
        data: [{ id: 'si_test_current' }],
      },
    });
    const subscriptionUpdate = vi.fn();
    const orderInserts: unknown[] = [];

    stripeState.buildStripeMetadata.mockReturnValue({
      itemType: 'membership_plan',
      itemId: '123e4567-e89b-42d3-a456-426614174222',
      userId: 'user-1',
      priceId: 'price_test_gold_yearly',
      billingCycle: 'yearly',
    });
    stripeState.getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: subscriptionRetrieve,
        update: subscriptionUpdate,
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
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
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [{
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                stripe_customer_id: 'cus_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
              }],
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
          return createInsertBuilder(
            Promise.resolve({
              error: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "payment_orders_stripe_checkout_session_id_key"',
              },
            }),
            orderInserts,
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
      caller.changeSubscriptionPlan({
        planId: '123e4567-e89b-42d3-a456-426614174222',
        billingCycle: 'yearly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '该订阅升级正在处理中，请等待付款完成后再试。',
    });

    expect(orderInserts).toHaveLength(1);
    expect(orderInserts[0]).toMatchObject({
      stripe_checkout_session_id: 'change_subscription_plan_lock:sub_test_active',
    });
    expect(subscriptionRetrieve).toHaveBeenCalledWith('sub_test_active');
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('rejects duplicate changeSubscriptionPlan requests before Stripe subscription update', async () => {
    const subscriptionUpdate = vi.fn();
    stripeState.getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: vi.fn(),
        update: subscriptionUpdate,
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
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
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [{
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
              }],
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

    const caller = createProtectedCaller({ supabase: userSupabase });

    await expect(
      caller.changeSubscriptionPlan({
        planId: '123e4567-e89b-42d3-a456-426614174111',
        billingCycle: 'monthly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '当前套餐仍有效，无需重复购买。',
    });

    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('rejects repeated pending changeSubscriptionPlan requests before Stripe subscription update', async () => {
    const subscriptionUpdate = vi.fn();
    const subscriptionRetrieve = vi.fn();
    stripeState.getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: subscriptionRetrieve,
        update: subscriptionUpdate,
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
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
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [{
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                stripe_customer_id: 'cus_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
              }],
              error: null,
            }),
          );
        }

        if (table === 'payment_orders') {
          return createMaybeSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'order-change-pending',
                item_id: '123e4567-e89b-42d3-a456-426614174222',
                billing_cycle: 'yearly',
                status: 'pending',
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
    });

    await expect(
      caller.changeSubscriptionPlan({
        planId: '123e4567-e89b-42d3-a456-426614174222',
        billingCycle: 'yearly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '该订阅升级正在处理中，请等待付款完成后再试。',
    });

    expect(subscriptionRetrieve).not.toHaveBeenCalled();
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('rejects subscription changes before Stripe update when the plan-change source row cannot be saved', async () => {
    const subscriptionRetrieve = vi.fn().mockResolvedValue({
      id: 'sub_test_active',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { userId: 'user-1' },
      items: {
        data: [
          {
            id: 'si_test_current',
            current_period_start: 1_742_646_400,
            current_period_end: 1_745_238_400,
          },
        ],
      },
    });
    const subscriptionUpdate = vi.fn();
    const orderInserts: unknown[] = [];
    stripeState.buildStripeMetadata.mockReturnValue({
      itemType: 'membership_plan',
      itemId: '123e4567-e89b-42d3-a456-426614174222',
      userId: 'user-1',
      priceId: 'price_test_gold_yearly',
      billingCycle: 'yearly',
    });
    stripeState.getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: subscriptionRetrieve,
        update: subscriptionUpdate,
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
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
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [{
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                stripe_customer_id: 'cus_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
              }],
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
          return createInsertBuilder(
            Promise.resolve({ error: { message: 'permission denied for table payment_orders' } }),
            orderInserts,
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
      caller.changeSubscriptionPlan({
        planId: '123e4567-e89b-42d3-a456-426614174222',
        billingCycle: 'yearly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '保存订阅升级记录失败，请稍后重试',
    });

    expect(subscriptionRetrieve).toHaveBeenCalledWith('sub_test_active');
    expect(orderInserts).toHaveLength(1);
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('marks the plan-change source row failed when Stripe rejects the subscription update', async () => {
    const subscriptionRetrieve = vi.fn().mockResolvedValue({
      id: 'sub_test_active',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { userId: 'user-1' },
      items: {
        data: [
          {
            id: 'si_test_current',
            current_period_start: 1_742_646_400,
            current_period_end: 1_745_238_400,
          },
        ],
      },
    });
    const subscriptionUpdate = vi.fn().mockRejectedValue(new Error('Stripe subscription update failed'));
    const orderInserts: unknown[] = [];
    const orderUpdates: unknown[] = [];
    const subscriptionUpdates: unknown[] = [];
    stripeState.buildStripeMetadata.mockReturnValue({
      itemType: 'membership_plan',
      itemId: '123e4567-e89b-42d3-a456-426614174222',
      userId: 'user-1',
      priceId: 'price_test_gold_yearly',
      billingCycle: 'yearly',
    });
    stripeState.getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: subscriptionRetrieve,
        update: subscriptionUpdate,
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
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
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [{
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174111',
                stripe_subscription_id: 'sub_test_active',
                stripe_customer_id: 'cus_test_active',
                status: 'active',
                billing_cycle: 'monthly',
                cancel_at_period_end: 'false',
              }],
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
          return {
            ...createInsertBuilder(
              Promise.resolve({ data: { id: 'order-change-1' }, error: null }),
              orderInserts,
            ),
            ...createUpdateBuilder(Promise.resolve({ error: null }), orderUpdates),
          };
        }

        if (table === 'user_subscriptions') {
          return createUpdateBuilder(Promise.resolve({ error: null }), subscriptionUpdates);
        }

        throw new Error(`Unexpected admin table ${table}`);
      },
    };

    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: adminSupabase,
    });

    await expect(
      caller.changeSubscriptionPlan({
        planId: '123e4567-e89b-42d3-a456-426614174222',
        billingCycle: 'yearly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '切换订阅套餐失败，请稍后重试',
    });

    expect(orderInserts).toHaveLength(1);
    expect(subscriptionUpdate).toHaveBeenCalledWith('sub_test_active', expect.any(Object));
    expect(orderUpdates).toEqual([
      expect.objectContaining({
        status: 'failed',
        payment_status: 'failed',
      }),
    ]);
    expect(syncSubscriptionState).not.toHaveBeenCalled();
    expect(subscriptionUpdates).toHaveLength(0);
  });

  it('rejects downgrade changeSubscriptionPlan requests before Stripe subscription update', async () => {
    const subscriptionUpdate = vi.fn();
    stripeState.getStripeClient.mockReturnValue({
      subscriptions: {
        retrieve: vi.fn(),
        update: subscriptionUpdate,
      },
    });

    const userSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                email: 'user@example.com',
                nickname: 'User',
                membership_level: 'gold',
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
              },
              error: null,
            }),
          );
        }

        if (table === 'user_subscriptions') {
          return createListQueryBuilder(
            Promise.resolve({
              data: [{
                id: 'sub-row-1',
                membership_plan_id: '123e4567-e89b-42d3-a456-426614174222',
                stripe_subscription_id: 'sub_test_active',
                status: 'active',
                billing_cycle: 'yearly',
                cancel_at_period_end: 'false',
              }],
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

    const caller = createProtectedCaller({ supabase: userSupabase });

    await expect(
      caller.changeSubscriptionPlan({
        planId: '123e4567-e89b-42d3-a456-426614174111',
        billingCycle: 'monthly',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'BAD_REQUEST',
      message: '当前会员有效，暂不支持降级。',
    });

    expect(subscriptionUpdate).not.toHaveBeenCalled();
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

    expect(stripeState.getOrCreateStripeCustomerId).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase: adminSupabase,
        userId: 'user-1',
      }),
    );
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(orderInserts[0]).toMatchObject({
      user_id: 'user-1',
      item_type: 'membership_plan',
      item_id: '123e4567-e89b-42d3-a456-426614174222',
      billing_cycle: 'yearly',
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_test_membership',
      stripe_price_id: 'price_test_gold_yearly',
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

    expect(stripeState.getOrCreateStripeCustomerId).toHaveBeenCalledWith(
      expect.objectContaining({
        supabase: adminSupabase,
        userId: 'user-1',
      }),
    );
    expect(sessionCreate).toHaveBeenCalledOnce();
    expect(orderInserts[0]).toMatchObject({
      user_id: 'user-1',
      item_type: 'membership_plan',
      item_id: '123e4567-e89b-42d3-a456-426614174555',
      billing_cycle: 'monthly',
      stripe_customer_id: 'cus_123',
      stripe_subscription_id: 'sub_test_stale_admin_override',
      stripe_price_id: 'price_test_pro_monthly',
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
    vi.mocked(upsertPaymentOrderBySession).mockResolvedValue(undefined);
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
    vi.mocked(upsertPaymentOrderBySession).mockResolvedValue(undefined);
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
                  payment_status: 'paid',
                  fulfilled_at: '2026-07-04T00:00:02.000Z',
                  stripe_subscription_id: 'sub_test_sync_duplicate',
                  stripe_invoice_id: 'in_test_sync_duplicate',
                },
                {
                  status: 'completed',
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
    vi.mocked(upsertPaymentOrderBySession).mockResolvedValue(undefined);
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
    vi.mocked(upsertPaymentOrderBySession).mockResolvedValue(undefined);
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
    vi.mocked(upsertPaymentOrderBySession).mockResolvedValue(undefined);
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
    vi.mocked(upsertPaymentOrderBySession).mockResolvedValue(undefined);
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
