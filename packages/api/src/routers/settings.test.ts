import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/stripe', () => ({
  isStripeCheckoutConfigured: () => true,
}));
import { getPublicReadClient, settingsRouter } from './settings';

function createQueryBuilder(result: Promise<unknown>) {
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
    in() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createPublicCatalogCaller(table: string, result: Promise<unknown>) {
  return settingsRouter.createCaller({
    supabase: {},
    supabasePublic: {
      from(actualTable: string) {
        expect(actualTable).toBe(table);
        return createQueryBuilder(result);
      },
    },
    supabaseAdmin: {},
    hasSupabaseAdminPrivileges: false,
  } as any);
}

const validCreditPackage = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  name: 'Starter credits',
  price: 1200,
  credits_amount: 1500,
  bonus_credits: 100,
  is_popular: 'true',
  sort_order: 1,
  stripe_price_id: 'price_test_package',
};

const validMembershipPlan = {
  id: '123e4567-e89b-42d3-a456-426614174111',
  name: 'Pro',
  level: 'pro',
  is_active: 'true',
  monthly_price: 9900,
  yearly_price: 99900,
  monthly_credits: 1000,
  monthly_bonus_credits: 100,
  yearly_credits: 12000,
  package_discount: 90,
  history_retention_days: 30,
  features: ['Feature A'],
  stripe_monthly_price_id: 'price_test_monthly',
  stripe_yearly_price_id: 'price_test_yearly',
};

describe('getPublicReadClient', () => {
  it('uses the public client even when admin credentials are configured', () => {
    const publicClient = { role: 'public' };
    const adminClient = { role: 'admin' };

    expect(
      getPublicReadClient({
        supabase: { role: 'auth-scoped' } as any,
        supabasePublic: publicClient as any,
        supabaseAdmin: adminClient as any,
        hasSupabaseAdminPrivileges: true,
      }),
    ).toBe(publicClient);
  });

  it('returns a safe generic message when public system settings lookup fails', async () => {
    const caller = settingsRouter.createCaller({
      supabase: {},
      supabasePublic: {
        from(table: string) {
          expect(table).toBe('system_settings');
          return createQueryBuilder(
            Promise.resolve({
              data: null,
              error: { message: 'permission denied for table system_settings' },
            }),
          );
        },
      },
      supabaseAdmin: {},
      hasSupabaseAdminPrivileges: true,
    } as any);

    await expect(caller.getSystemSettings()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取系统设置失败，请稍后重试',
    });
  });

  it('returns a safe generic message when admin system settings lookup fails', async () => {
    const caller = settingsRouter.createCaller({
      headers: new Headers(),
      user: {
        id: 'admin-user',
        email: 'admin@example.com',
        app_metadata: { provider: 'email' },
        user_metadata: { email_verified: true },
      },
      isEmailVerified: true,
      authProvider: 'email',
      supabase: {
        from(table: string) {
          if (table === 'profiles') {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              single() {
                return Promise.resolve({
                  data: {
                    id: 'admin-user',
                    role: 'admin',
                    status: 'active',
                    nickname: 'Admin',
                    email: 'admin@example.com',
                  },
                  error: null,
                });
              },
            };
          }

          if (table === 'system_settings') {
            return {
              select() {
                return Promise.resolve({
                  data: null,
                  error: { message: 'permission denied for table system_settings' },
                });
              },
            };
          }

          throw new Error(`Unexpected table ${table}`);
        },
      },
      supabasePublic: {},
      supabaseAdmin: {
        from() {
          return {
            select() {
              return Promise.resolve({
                data: null,
                error: { message: 'permission denied for table system_settings' },
              });
            },
          };
        },
      },
      hasSupabaseAdminPrivileges: true,
    } as any);

    await expect(caller.getAdminSystemSettings()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '读取系统设置失败，请稍后重试',
    });
  });

  it('updates system settings in a single bulk upsert for admins', async () => {
    const caller = settingsRouter.createCaller({
      headers: new Headers(),
      user: {
        id: 'admin-user',
        email: 'admin@example.com',
        app_metadata: { provider: 'email' },
        user_metadata: { email_verified: true },
      },
      isEmailVerified: true,
      authProvider: 'email',
      supabase: {
        from(table: string) {
          if (table === 'profiles') {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              single() {
                return Promise.resolve({
                  data: {
                    id: 'admin-user',
                    role: 'admin',
                    status: 'active',
                    nickname: 'Admin',
                    email: 'admin@example.com',
                  },
                  error: null,
                });
              },
            };
          }

          if (table === 'system_settings') {
            return {
              upsert(rows: Array<{ key: string; value: unknown }>, options: { onConflict: string }) {
                expect(options).toEqual({ onConflict: 'key' });
                expect(rows).toEqual([
                  { key: 'site_name', value: 'GraylumAI' },
                  { key: 'support_email', value: 'support@example.com' },
                ]);

                return {
                  select() {
                    return Promise.resolve({
                      data: rows,
                      error: null,
                    });
                  },
                };
              },
            };
          }

          throw new Error(`Unexpected table ${table}`);
        },
      },
      supabasePublic: {},
      supabaseAdmin: {
        from(table: string) {
          expect(table).toBe('system_settings');
          return {
            upsert(rows: Array<{ key: string; value: unknown }>, options: { onConflict: string }) {
              expect(options).toEqual({ onConflict: 'key' });
              expect(rows).toEqual([
                { key: 'site_name', value: 'GraylumAI' },
                { key: 'support_email', value: 'support@example.com' },
              ]);

              return {
                select() {
                  return Promise.resolve({
                    data: rows,
                    error: null,
                  });
                },
              };
            },
          };
        },
      },
      hasSupabaseAdminPrivileges: true,
    } as any);

    await expect(
      caller.updateSystemSettingsBulk([
        { key: 'site_name', value: 'GraylumAI' },
        { key: 'support_email', value: 'support@example.com' },
      ]),
    ).resolves.toEqual([
      { key: 'site_name', value: 'GraylumAI' },
      { key: 'support_email', value: 'support@example.com' },
    ]);
  });
});

describe('public catalog availability', () => {
  it('returns a validated non-empty credit package catalog', async () => {
    const caller = createPublicCatalogCaller(
      'credit_packages',
      Promise.resolve({ data: [validCreditPackage], error: null }),
    );

    await expect(caller.getCreditPackages()).resolves.toEqual([{
      id: validCreditPackage.id,
      name: validCreditPackage.name,
      credits: 1500,
      bonus_credits: 100,
      price: 12,
      is_popular: true,
      checkout_ready: true,
    }]);
  });

  it('returns [] only for a successful empty active credit package catalog', async () => {
    const caller = createPublicCatalogCaller(
      'credit_packages',
      Promise.resolve({ data: [], error: null }),
    );

    await expect(caller.getCreditPackages()).resolves.toEqual([]);
  });

  it('keeps a valid credit package visible when its Stripe Price is missing', async () => {
    const caller = createPublicCatalogCaller(
      'credit_packages',
      Promise.resolve({
        data: [{ ...validCreditPackage, stripe_price_id: null }],
        error: null,
      }),
    );

    await expect(caller.getCreditPackages()).resolves.toEqual([
      expect.objectContaining({
        id: validCreditPackage.id,
        price: 12,
        checkout_ready: false,
      }),
    ]);
  });

  it.each([null, '', '   '])(
    'keeps a credit package visible but not checkout-ready for an unconfigured Price %#',
    async (stripePriceId) => {
      const caller = createPublicCatalogCaller(
        'credit_packages',
        Promise.resolve({
          data: [{ ...validCreditPackage, stripe_price_id: stripePriceId }],
          error: null,
        }),
      );

      await expect(caller.getCreditPackages()).resolves.toEqual([
        expect.objectContaining({
          id: validCreditPackage.id,
          checkout_ready: false,
        }),
      ]);
    },
  );

  it.each([
    ['RLS denial', () => Promise.resolve({ data: null, error: { code: '42501' } })],
    ['query timeout', () => Promise.resolve({ data: null, error: { code: '57014' } })],
    ['missing table', () => Promise.resolve({ data: null, error: { code: '42P01' } })],
    ['null successful payload', () => Promise.resolve({ data: null, error: null })],
    ['invalid row', () => Promise.resolve({ data: [{ ...validCreditPackage, price: null }], error: null })],
    ['network rejection', () => Promise.reject(new Error('network unavailable'))],
  ])('marks credit packages unavailable for %s', async (_caseName, createResult) => {
    const caller = createPublicCatalogCaller('credit_packages', createResult());

    await expect(caller.getCreditPackages()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '套餐服务暂不可用，请稍后重试',
    });
  });

  it('returns a validated membership catalog and preserves cycle-specific Price readiness', async () => {
    const caller = createPublicCatalogCaller(
      'membership_plans',
      Promise.resolve({
        data: [{ ...validMembershipPlan, stripe_yearly_price_id: null }],
        error: null,
      }),
    );

    await expect(caller.getMembershipPlans()).resolves.toEqual([
      expect.objectContaining({
        id: validMembershipPlan.id,
        price: { monthly: 99, yearly: 999 },
        credits: {
          monthly: 1000,
          monthlyBonus: 100,
          yearly: 12000,
          yearlyBonus: 0,
        },
        features: ['Feature A'],
        checkoutReady: { monthly: true, yearly: false },
      }),
    ]);
  });

  it.each([
    ['', 'price_test_yearly'],
    ['   ', 'price_test_yearly'],
    ['price_test_monthly', ''],
    ['price_test_monthly', '   '],
  ])(
    'keeps a membership plan visible with blank cycle Price IDs disabled',
    async (monthlyPriceId, yearlyPriceId) => {
      const caller = createPublicCatalogCaller(
        'membership_plans',
        Promise.resolve({
          data: [{
            ...validMembershipPlan,
            stripe_monthly_price_id: monthlyPriceId,
            stripe_yearly_price_id: yearlyPriceId,
          }],
          error: null,
        }),
      );

      await expect(caller.getMembershipPlans()).resolves.toEqual([
        expect.objectContaining({
          id: validMembershipPlan.id,
          checkoutReady: {
            monthly: Boolean(monthlyPriceId.trim()),
            yearly: Boolean(yearlyPriceId.trim()),
          },
        }),
      ]);
    },
  );

  it('returns [] only for a successful catalog with no active membership plans', async () => {
    const caller = createPublicCatalogCaller(
      'membership_plans',
      Promise.resolve({ data: [], error: null }),
    );

    await expect(caller.getMembershipPlans()).resolves.toEqual([]);
  });

  it.each([
    ['RLS denial', () => Promise.resolve({ data: null, error: { code: '42501' } })],
    ['query timeout', () => Promise.resolve({ data: null, error: { code: '57014' } })],
    ['null successful payload', () => Promise.resolve({ data: null, error: null })],
    ['invalid price', () => Promise.resolve({ data: [{ ...validMembershipPlan, monthly_price: null }], error: null })],
    ['invalid features', () => Promise.resolve({ data: [{ ...validMembershipPlan, features: 'not-an-array' }], error: null })],
    ['network rejection', () => Promise.reject(new Error('network unavailable'))],
  ])('marks membership plans unavailable for %s', async (_caseName, createResult) => {
    const caller = createPublicCatalogCaller('membership_plans', createResult());

    await expect(caller.getMembershipPlans()).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: '套餐服务暂不可用，请稍后重试',
    });
  });
});
