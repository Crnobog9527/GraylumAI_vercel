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
  syncSubscriptionState: vi.fn(),
  upsertPaymentOrderBySession: vi.fn(),
}));

import { paymentsRouter } from './payments';
import {
  fulfillMembershipInvoice,
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
      return result;
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

  it('uses the service-role client for checkout customer lookup and order insert', async () => {
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
    });
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
    vi.mocked(syncSubscriptionState).mockResolvedValue(undefined);
    vi.mocked(fulfillMembershipInvoice).mockResolvedValue(undefined);

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

    expect(upsertPaymentOrderBySession).toHaveBeenCalledWith(adminSupabase, session);
    expect(syncSubscriptionState).toHaveBeenCalledWith(adminSupabase, subscription);
    expect(fulfillMembershipInvoice).toHaveBeenCalledWith(adminSupabase, paidInvoice);
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
    vi.mocked(syncSubscriptionState).mockResolvedValue(undefined);
    vi.mocked(fulfillMembershipInvoice).mockRejectedValue(
      Object.assign(new Error('Failed to fulfill membership invoice'), {
        stage: 'fulfill_membership_invoice_rpc',
        safeContext: {
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
    const caller = createProtectedCaller({
      supabase: userSupabase,
      supabaseAdmin: {
        from(table: string) {
          throw new Error(`Unexpected admin table ${table}`);
        },
      },
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
        stage: 'fulfill_membership_invoice',
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
  });
});
