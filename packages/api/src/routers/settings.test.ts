import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/stripe', () => ({
  isStripeCheckoutConfigured: () => true,
}));
import { getPublicReadClient, settingsRouter } from './settings';

describe('settings writer verification', () => {
  it.each(['single', 'bulk'] as const)('fails closed with a safe service error when the %s writer profile cannot be read', async (mode) => {
    const upsert = vi.fn();
    const profile = { id: 'admin-user', role: 'admin', status: 'active', nickname: 'Admin', email: 'admin@example.test' };
    const client = (result: unknown) => ({ from: (table: string) => {
      if (table === 'system_settings') return { upsert };
      return { select() { return this; }, eq() { return this; }, single: async () => result };
    } });
    const caller = settingsRouter.createCaller({
      headers: new Headers(),
      user: { id: profile.id, email: profile.email, app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
      isEmailVerified: true, authProvider: 'email', hasSupabaseAdminPrivileges: true,
      supabase: client({ data: profile, error: null }), supabasePublic: {},
      supabaseAdmin: client({ data: null, error: { code: '42501', message: 'permission denied SECRET_CANARY' } }),
    } as any);
    const input = { key: 'max_input_characters', value: '10000' };
    await expect(mode === 'single' ? caller.updateSystemSettings(input) : caller.updateSystemSettingsBulk([input]))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '暂时无法验证设置保存权限，请稍后重试' });
    expect(upsert).not.toHaveBeenCalled();
  });
});

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
          if(table==='profiles')return {select(){return this;},eq(){return this;},single:async()=>({data:{role:'admin',status:'active',is_deleted:'false'},error:null})};
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
          if(table==='profiles')return {select(){return this;},eq(){return this;},single:async()=>({data:{role:'admin',status:'active',is_deleted:'false'},error:null})};
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

  it('rejects an invalid launch_baseline_at before any write', async () => {
    const upsert = vi.fn();
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
              select() { return this; },
              eq() { return this; },
              single: async () => ({
                data: {
                  id: 'admin-user',
                  role: 'admin',
                  status: 'active',
                  nickname: 'Admin',
                  email: 'admin@example.com',
                },
                error: null,
              }),
            };
          }
          return { upsert };
        },
      },
      supabasePublic: {},
      supabaseAdmin: {
        from(table: string) {
          if(table==='profiles')return {select(){return this;},eq(){return this;},single:async()=>({data:{role:'admin',status:'active',is_deleted:'false'},error:null})};
          expect(table).toBe('system_settings');
          const builder = {
            select: () => builder,
            eq: () => builder,
            maybeSingle: async () => ({
              data: { value: '2026-09-04T00:00:00+08:00' },
              error: null,
            }),
          };
          return builder;
        },
      },
      hasSupabaseAdminPrivileges: true,
    } as any);

    await expect(caller.updateSystemSettings({
      key: 'launch_baseline_at',
      value: 'not-a-timestamp',
    })).rejects.toMatchObject<Partial<TRPCError>>({ code: 'BAD_REQUEST' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('reads launch_baseline_at only through the admin procedure', async () => {
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
              select() { return this; },
              eq() { return this; },
              single: async () => ({
                data: {
                  id: 'admin-user',
                  role: 'admin',
                  status: 'active',
                  nickname: 'Admin',
                  email: 'admin@example.com',
                },
                error: null,
              }),
            };
          }
          if (table === 'system_settings') {
            const builder = {
              select: () => builder,
              eq: () => builder,
              maybeSingle: async () => ({
                data: { value: '2026-09-04T00:00:00+08:00' },
                error: null,
              }),
            };
            return builder;
          }
          throw new Error(`Unexpected table ${table}`);
        },
      },
      supabasePublic: {},
      supabaseAdmin: {
        from(table: string) {
          if(table==='profiles')return {select(){return this;},eq(){return this;},single:async()=>({data:{role:'admin',status:'active',is_deleted:'false'},error:null})};
          expect(table).toBe('system_settings');
          const builder = {
            select: () => builder,
            eq: () => builder,
            maybeSingle: async () => ({
              data: { value: '2026-09-04T00:00:00+08:00' },
              error: null,
            }),
          };
          return builder;
        },
      },
      hasSupabaseAdminPrivileges: true,
    } as any);

    await expect(caller.getLaunchBaseline()).resolves.toMatchObject({
      status: 'READY',
      launchBaselineAtIso: '2026-09-03T16:00:00.000Z',
    });
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

describe('PAY-1 positive-amount catalog readiness', () => {
  it('keeps zero-price packages visible without checkout readiness', async () => {
    const caller = createPublicCatalogCaller('credit_packages', Promise.resolve({ data: [{ ...validCreditPackage, price: 0 }], error: null }));
    expect(await caller.getCreditPackages()).toEqual([expect.objectContaining({ checkout_ready: false })]);
  });
  it.each(['monthly', 'yearly'] as const)('disables a zero-price %s cycle independently', async (cycle) => {
    const caller = createPublicCatalogCaller('membership_plans', Promise.resolve({ data: [{ ...validMembershipPlan, [`${cycle}_price`]: 0 }], error: null }));
    expect(await caller.getMembershipPlans()).toEqual([expect.objectContaining({ checkoutReady: { monthly: cycle !== 'monthly', yearly: cycle !== 'yearly' } })]);
  });
  it.each([-1, null, '', undefined])('preserves unavailable semantics for malformed amounts %j', async (amount) => {
    const packages = createPublicCatalogCaller('credit_packages', Promise.resolve({ data: [{ ...validCreditPackage, price: amount }], error: null }));
    await expect(packages.getCreditPackages()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    for (const cycle of ['monthly', 'yearly']) {
      const plans = createPublicCatalogCaller('membership_plans', Promise.resolve({ data: [{ ...validMembershipPlan, [`${cycle}_price`]: amount }], error: null }));
      await expect(plans.getMembershipPlans()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
  });
});

describe('summary model admin endpoint',()=>{
  const row={id:'11111111-1111-4111-8111-111111111111',name:'Summary',model_id:'openai/gpt-4o-mini-2024-07-18',is_active:'true',max_tokens:2048,input_limit:128000,api_key:'SECRET_CANARY',api_endpoint:'https://openrouter.ai/api/v1',token_counting_supported:'true',tokenizer_family:'openai'};
  function caller(role:'admin'|'user'|null,error=false){
    const query=vi.fn(()=>createQueryBuilder(Promise.resolve(error?{data:null,error:{message:'SECRET_CANARY'}}:{data:[row,{...row,id:'22222222-2222-4222-8222-222222222222',api_key:''}],error:null})));
    const client={from(table:string){
      if(table==='ai_models')return query();
      if(table==='profiles')return {select(){return this;},eq(){return this;},single:async()=>({data:{id:'test-user',role,status:'active',nickname:'Test',email:'test@example.test'},error:null})};
      throw new Error('Unexpected table');
    }};
    return {query,api:settingsRouter.createCaller({headers:new Headers(),user:role?{id:'test-user',email:'test@example.test',app_metadata:{provider:'email'},user_metadata:{email_verified:true}}:null,isEmailVerified:!!role,authProvider:'email',supabase:client,supabaseAdmin:client,supabasePublic:{},hasSupabaseAdminPrivileges:true} as any)};
  }
  it.each([[null,'UNAUTHORIZED'],['user','FORBIDDEN']] as const)('rejects %s before reading model credentials',async(role,code)=>{
    const t=caller(role);await expect(t.api.getSummaryModels()).rejects.toMatchObject({code});expect(t.query).not.toHaveBeenCalled();
  });
  it('returns only display fields to an administrator for valid and invalid configurations',async()=>{
    const t=caller('admin'),result=await t.api.getSummaryModels();expect(result.map(x=>x.available)).toEqual([true,false]);
    for(const option of result)expect(Object.keys(option).sort()).toEqual(['available','id','model_id','name','reason']);
    expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
  });
  it('does not expose database error details',async()=>{
    const t=caller('admin',true);await expect(t.api.getSummaryModels()).rejects.toMatchObject({code:'INTERNAL_SERVER_ERROR',message:'无法读取整理模型列表'});
  });
});
