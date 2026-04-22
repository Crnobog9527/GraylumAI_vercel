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

vi.mock('../services/stripe', () => ({
  assertStripeCheckoutConfigured: stripeState.assertStripeCheckoutConfigured,
  buildStripeMetadata: stripeState.buildStripeMetadata,
  calculateDiscountedAmountCents: stripeState.calculateDiscountedAmountCents,
  getOrCreateStripeCustomerId: stripeState.getOrCreateStripeCustomerId,
  getStripeAppUrl: stripeState.getStripeAppUrl,
  getStripeClient: stripeState.getStripeClient,
}));

vi.mock('../services/stripeFulfillment', () => ({
  fulfillCreditPackageOrder: vi.fn(),
  fulfillMembershipInvoice: vi.fn(),
  syncSubscriptionState: vi.fn(),
  upsertPaymentOrderBySession: vi.fn(),
}));

import { paymentsRouter } from './payments';

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
    vi.clearAllMocks();
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
});
