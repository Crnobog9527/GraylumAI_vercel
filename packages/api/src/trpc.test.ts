import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

describe('createTRPCContext', () => {
  beforeEach(() => {
    createClientMock.mockReset();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  });

  it('preserves an injected user-scoped Supabase client when user is already known', async () => {
    const publicClient = { role: 'public-client' };
    const adminClient = { role: 'admin-client' };
    const injectedAuthClient = {
      role: 'auth-client',
      auth: {
        getUser: vi.fn(),
      },
    };

    createClientMock
      .mockReturnValueOnce(publicClient)
      .mockReturnValueOnce(adminClient);

    const { createTRPCContext } = await import('./trpc');
    const user = {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      identities: [],
      email_confirmed_at: '2026-03-11T00:00:00.000Z',
    };

    const ctx = await createTRPCContext({
      headers: new Headers(),
      user: user as any,
      supabaseAuth: injectedAuthClient as any,
    });

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(ctx.supabaseAdmin).toBe(adminClient);
    expect(ctx.supabasePublic).toBe(publicClient);
    expect(ctx.supabase).toBe(injectedAuthClient);
    expect(ctx.supabaseAuth).toBe(injectedAuthClient);
    expect(ctx.hasSupabaseAdminPrivileges).toBe(true);
    expect(ctx.user?.id).toBe('user-1');
    expect(injectedAuthClient.auth.getUser).not.toHaveBeenCalled();
  });

  it('hydrates the user from an injected user-scoped Supabase client when needed', async () => {
    const publicClient = { role: 'public-client' };
    const adminClient = { role: 'admin-client' };
    const injectedAuthClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-2',
              email: 'cookie-user@example.com',
              app_metadata: { provider: 'email', providers: ['email'] },
              identities: [],
              email_confirmed_at: '2026-03-11T00:00:00.000Z',
            },
          },
          error: null,
        }),
      },
    };

    createClientMock
      .mockReturnValueOnce(publicClient)
      .mockReturnValueOnce(adminClient);

    const { createTRPCContext } = await import('./trpc');
    const ctx = await createTRPCContext({
      headers: new Headers(),
      supabaseAuth: injectedAuthClient as any,
    });

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(injectedAuthClient.auth.getUser).toHaveBeenCalledTimes(1);
    expect(ctx.supabasePublic).toBe(publicClient);
    expect(ctx.supabaseAuth).toBe(injectedAuthClient);
    expect(ctx.supabase).toBe(injectedAuthClient);
    expect(ctx.hasSupabaseAdminPrivileges).toBe(true);
    expect(ctx.user?.id).toBe('user-2');
  });

  it('marks admin privileges as unavailable when service role key is missing', async () => {
    const publicClient = { role: 'public-client' };
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    createClientMock.mockReturnValueOnce(publicClient);

    const { createTRPCContext } = await import('./trpc');
    const ctx = await createTRPCContext({
      headers: new Headers(),
    });

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(ctx.supabase).toBe(publicClient);
    expect(ctx.supabasePublic).toBe(publicClient);
    expect(ctx.supabaseAdmin).toBeNull();
    expect(ctx.hasSupabaseAdminPrivileges).toBe(false);
  });
});

describe('protectedProcedure profile bootstrap', () => {
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'new-user@example.com',
    app_metadata: { provider: 'email', providers: ['email'] },
    identities: [],
    email_confirmed_at: '2026-03-11T00:00:00.000Z',
    user_metadata: { full_name: 'New User' },
  };
  const recentBootstrapCreatedAt = '2026-06-26T00:00:00.000Z';
  const legacyProfileCreatedAt = '2026-06-24T23:59:59.000Z';

  function createProfilesSupabase(options: {
    existingProfile?: Record<string, unknown> | null;
    conflictProfile?: Record<string, unknown> | null;
    createError?: { code?: string; message?: string } | null;
    rpcError?: { message: string } | null;
    rpcErrorSequence?: Array<{ message: string } | null>;
    committedOpeningGrantAfterRpcError?: boolean;
    ledgerLookupErrorSequence?: Array<{ message: string } | null>;
    creditTransactions?: Array<Record<string, unknown>>;
    userSelectError?: { code?: string; message?: string } | null;
  } = {}) {
    let storedProfile = options.existingProfile
      ? { ...options.existingProfile }
      : null;
    let rpcCallIndex = 0;
    let ledgerLookupCallIndex = 0;
    const profileInserts: unknown[] = [];
    const userProfileInserts: unknown[] = [];
    const userProfileSelects: Array<{ field: string; value: unknown } | undefined> = [];
    const profileUpdates: unknown[] = [];
    const adminTableCalls: string[] = [];
    const profileDeletes: Array<{
      filters: Array<{ field: string; value: unknown }>;
      deleted: boolean;
    }> = [];
    const creditTransactions: Array<Record<string, unknown>> = options.creditTransactions
      ? options.creditTransactions.map((transaction) => ({ ...transaction }))
      : [];
    const writeOpeningGrantLedger = (args: { p_user_id?: string; p_amount?: number; p_idempotency_key?: string }) => {
      const amount = args.p_amount ?? 0;
      const balanceBefore = Number(storedProfile?.credits ?? 0);
      const balanceAfter = balanceBefore + amount;
      if (storedProfile) {
        storedProfile = {
          ...storedProfile,
          credits: balanceAfter,
        };
      }

      const transaction = {
        id: `txn-opening-grant-${creditTransactions.length + 1}`,
        user_id: args.p_user_id,
        amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        idempotency_key: args.p_idempotency_key,
      };
      creditTransactions.push(transaction);

      return transaction;
    };
    const rpc = vi.fn().mockImplementation(async (_functionName: string, args: {
      p_user_id?: string;
      p_amount?: number;
      p_idempotency_key?: string;
    }) => {
      const sequencedError = options.rpcErrorSequence?.[rpcCallIndex];
      rpcCallIndex += 1;
      const rpcError = sequencedError === undefined ? options.rpcError : sequencedError;

      if (rpcError) {
        if (options.committedOpeningGrantAfterRpcError) {
          writeOpeningGrantLedger(args);
        }

        return { data: null, error: rpcError };
      }

      const transaction = writeOpeningGrantLedger(args);

      return {
        data: [{
          transaction_id: transaction.id,
          balance_before: transaction.balance_before,
          balance_after: transaction.balance_after,
          amount: transaction.amount,
          is_idempotent: false,
        }],
        error: null,
      };
    });

    const userSupabase = {
      from(table: string) {
        expect(table).toBe('profiles');
        const state: {
          operation: 'select' | 'insert' | 'update' | 'delete';
          eq?: { field: string; value: unknown };
        } = { operation: 'select' };

        const builder = {
          select() {
            return builder;
          },
          eq(field: string, value: unknown) {
            state.eq = { field, value };
            return builder;
          },
          insert(payload: unknown) {
            state.operation = 'insert';
            userProfileInserts.push(payload);
            return builder;
          },
          update(payload: unknown) {
            state.operation = 'update';
            profileUpdates.push(payload);
            if (storedProfile) {
              storedProfile = {
                ...storedProfile,
                ...(payload as Record<string, unknown>),
              };
            }
            return builder;
          },
          async single() {
            if (state.operation === 'insert') {
              return { data: null, error: { code: '42501', message: 'client insert should not be used' } };
            }

            userProfileSelects.push(state.eq);
            if (options.userSelectError) {
              return { data: null, error: options.userSelectError };
            }

            return storedProfile
              ? { data: storedProfile, error: null }
              : { data: null, error: { code: 'PGRST116', message: 'Not found' } };
          },
        };

        return builder;
      },
    };

    const adminSupabase = {
      rpc,
      from(table: string) {
        adminTableCalls.push(table);
        expect(['profiles', 'credit_transactions']).toContain(table);
        const state: {
          operation: 'select' | 'insert' | 'delete';
          eq?: { field: string; value: unknown };
          filters: Array<{ field: string; value: unknown }>;
          payload?: Record<string, unknown>;
        } = { operation: 'select', filters: [] };

        const builder = {
          select() {
            return builder;
          },
          insert(payload: Record<string, unknown>) {
            state.operation = 'insert';
            state.payload = payload;
            profileInserts.push(payload);
            return builder;
          },
          delete() {
            state.operation = 'delete';
            return builder;
          },
          eq(field: string, value: unknown) {
            state.eq = { field, value };
            state.filters.push(state.eq);
            return builder;
          },
          async maybeSingle() {
            if (table !== 'credit_transactions') {
              return { data: null, error: { message: 'maybeSingle is only mocked for credit_transactions' } };
            }

            const sequencedLookupError = options.ledgerLookupErrorSequence?.[ledgerLookupCallIndex];
            ledgerLookupCallIndex += 1;
            if (sequencedLookupError) {
              return { data: null, error: sequencedLookupError };
            }

            const transaction = creditTransactions.find((row) =>
              state.filters.every((filter) => row[filter.field] === filter.value)
            );

            return transaction
              ? { data: transaction, error: null }
              : { data: null, error: null };
          },
          async single() {
            if (table !== 'profiles') {
              return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
            }

            if (state.operation === 'insert') {
              if (options.createError) {
                if (options.createError.code === '23505' && options.conflictProfile) {
                  storedProfile = { ...options.conflictProfile };
                }
                return { data: null, error: options.createError };
              }

              storedProfile = {
                ...state.payload,
                status: state.payload?.status ?? 'active',
                membership_level: state.payload?.membership_level ?? 'free',
                created_at: recentBootstrapCreatedAt,
              };
              return { data: storedProfile, error: null };
            }

            return storedProfile
              ? { data: storedProfile, error: null }
              : { data: null, error: { code: 'PGRST116', message: 'Not found' } };
          },
          then(
            onFulfilled: (value: { data: null; error: null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) {
            if (table === 'profiles' && state.operation === 'delete') {
              const deleted = Boolean(storedProfile)
                && state.filters.every((filter) => storedProfile?.[filter.field] === filter.value);
              profileDeletes.push({
                filters: [...state.filters],
                deleted,
              });
              if (deleted) {
                storedProfile = null;
              }
            }

            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
          },
        };

        return builder;
      },
    };

    return {
      userSupabase,
      adminSupabase,
      rpc,
      profileInserts,
      userProfileInserts,
      userProfileSelects,
      profileUpdates,
      adminTableCalls,
      profileDeletes,
      creditTransactions,
      getStoredProfile: () => storedProfile,
    };
  }

  async function callProtectedProcedure(
    supabaseMocks: ReturnType<typeof createProfilesSupabase>,
    options: {
      hasSupabaseAdminPrivileges?: boolean;
      isEmailVerified?: boolean;
      userOverride?: unknown;
    } = {},
  ) {
    const { router, protectedProcedure } = await import('./trpc');
    const testRouter = router({
      readProfileContext: protectedProcedure.query(({ ctx }) => ({
        profileId: ctx.profileId,
        userRole: ctx.userRole,
        userStatus: ctx.userStatus,
        supabaseIsUserScoped: ctx.supabase === supabaseMocks.userSupabase,
      })),
    });

    const caller = testRouter.createCaller({
      headers: new Headers(),
      supabase: supabaseMocks.userSupabase as any,
      supabasePublic: supabaseMocks.userSupabase as any,
      supabaseAdmin: supabaseMocks.adminSupabase as any,
      supabaseAuth: supabaseMocks.userSupabase as any,
      hasSupabaseAdminPrivileges: options.hasSupabaseAdminPrivileges ?? true,
      user: (options.userOverride ?? user) as any,
      authProvider: 'email',
      isEmailVerified: options.isEmailVerified ?? true,
    });

    return caller.readProfileContext();
  }

  it('writes an opening grant ledger entry after creating a new user profile', async () => {
    const supabaseMocks = createProfilesSupabase();

    const result = await callProtectedProcedure(supabaseMocks);

    expect(supabaseMocks.profileInserts).toEqual([
      expect.objectContaining({
        id: user.id,
        email: user.email,
        nickname: 'New User',
        role: 'user',
        status: 'active',
        membership_level: 'free',
        credits: 0,
      }),
    ]);
    expect(supabaseMocks.userProfileInserts).toEqual([]);
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', {
      p_user_id: user.id,
      p_amount: 100,
      p_type: 'addition',
      p_description: 'Opening grant for new user profile bootstrap',
      p_idempotency_key: `opening_grant:${user.id}`,
    });
    expect(result).toEqual({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
      supabaseIsUserScoped: true,
    });
  });

  it('falls back to the server-side bootstrap client when user-scoped profile reads are unavailable', async () => {
    const supabaseMocks = createProfilesSupabase({
      userSelectError: { code: '42501', message: 'permission denied for table profiles' },
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
      supabaseIsUserScoped: true,
    });

    expect(supabaseMocks.adminTableCalls.slice(0, 2)).toEqual(['profiles', 'profiles']);
    expect(supabaseMocks.userProfileSelects).toEqual([{ field: 'id', value: user.id }]);
    expect(supabaseMocks.userProfileInserts).toEqual([]);
    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('blocks an unverified auth user before profile bootstrap or opening grant', async () => {
    const supabaseMocks = createProfilesSupabase();
    const dashboardCreatedUser = {
      ...user,
      email_confirmed_at: null,
      identities: [],
      user_metadata: { name: 'Dashboard User' },
    };

    await expect(callProtectedProcedure(supabaseMocks, {
      isEmailVerified: false,
      userOverride: dashboardCreatedUser,
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'EMAIL_NOT_VERIFIED',
    });

    expect(supabaseMocks.profileInserts).toEqual([]);
    expect(supabaseMocks.userProfileInserts).toEqual([]);
    expect(supabaseMocks.userProfileSelects).toEqual([]);
    expect(supabaseMocks.adminTableCalls).toEqual([]);
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
  });

  it('bootstraps a first Google OAuth user and keeps the opening grant exactly once', async () => {
    const supabaseMocks = createProfilesSupabase();
    const googleUser = {
      ...user,
      app_metadata: { provider: 'google', providers: ['google'] },
      email_confirmed_at: null,
      identities: [],
    };
    const { isEmailVerified } = await import('./lib/auth');

    expect(isEmailVerified(googleUser as any)).toBe(true);
    await expect(callProtectedProcedure(supabaseMocks, {
      userOverride: googleUser,
      isEmailVerified: isEmailVerified(googleUser as any),
    })).resolves.toMatchObject({ profileId: user.id });
    await expect(callProtectedProcedure(supabaseMocks, {
      userOverride: googleUser,
      isEmailVerified: isEmailVerified(googleUser as any),
    })).resolves.toMatchObject({ profileId: user.id });

    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.creditTransactions).toHaveLength(1);
  });

  it('does not issue another opening grant when the profile already exists', async () => {
    const supabaseMocks = createProfilesSupabase({
      existingProfile: {
        id: user.id,
        role: 'user',
        credits: 100,
        status: 'active',
        nickname: 'Existing User',
        email: user.email,
      },
    });

    const result = await callProtectedProcedure(supabaseMocks);

    expect(supabaseMocks.profileInserts).toEqual([]);
    expect(supabaseMocks.userProfileInserts).toEqual([]);
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
    });
  });

  it('does not issue an opening grant when server-side profile creation fails', async () => {
    const supabaseMocks = createProfilesSupabase({
      createError: { code: '42501', message: 'permission denied' },
    });

    await expect(callProtectedProcedure(supabaseMocks)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('profile_bootstrap_failed'),
    });
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.userProfileInserts).toEqual([]);
  });

  it('handles profile insert conflicts by refetching an already-granted profile without another opening grant', async () => {
    const supabaseMocks = createProfilesSupabase({
      createError: { code: '23505', message: 'duplicate key value violates unique constraint profiles_pkey' },
      conflictProfile: {
        id: user.id,
        role: 'user',
        credits: 100,
        status: 'active',
        nickname: 'Existing User',
        email: user.email,
        membership_level: 'free',
      },
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
    });
    expect(supabaseMocks.profileInserts).toEqual([
      expect.objectContaining({
        id: user.id,
        credits: 0,
        role: 'user',
        membership_level: 'free',
      }),
    ]);
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
  });

  it('recovers a missing opening grant after a concurrent profile insert conflict', async () => {
    const supabaseMocks = createProfilesSupabase({
      createError: { code: '23505', message: 'duplicate key value violates unique constraint profiles_pkey' },
      conflictProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'New User',
        email: user.email,
        membership_level: 'free',
        created_at: recentBootstrapCreatedAt,
      },
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
    });

    expect(supabaseMocks.profileInserts).toEqual([
      expect.objectContaining({
        id: user.id,
        credits: 0,
        role: 'user',
        membership_level: 'free',
      }),
    ]);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', expect.objectContaining({
      p_user_id: user.id,
      p_idempotency_key: `opening_grant:${user.id}`,
    }));
    expect(supabaseMocks.creditTransactions).toEqual([
      expect.objectContaining({
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }),
    ]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 100,
    });
  });

  it('does not duplicate an existing opening grant after a concurrent profile insert conflict', async () => {
    const supabaseMocks = createProfilesSupabase({
      createError: { code: '23505', message: 'duplicate key value violates unique constraint profiles_pkey' },
      conflictProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'New User',
        email: user.email,
        membership_level: 'free',
        created_at: recentBootstrapCreatedAt,
      },
      creditTransactions: [{
        id: 'txn-existing-opening-grant',
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }],
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
    });

    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.creditTransactions).toHaveLength(1);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 0,
    });
  });

  it('does not recover historical zero-credit profiles after a concurrent profile insert conflict', async () => {
    const supabaseMocks = createProfilesSupabase({
      createError: { code: '23505', message: 'duplicate key value violates unique constraint profiles_pkey' },
      conflictProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'Existing User',
        email: user.email,
        membership_level: 'free',
        created_at: legacyProfileCreatedAt,
      },
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
    });

    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 0,
    });
  });

  it('does not reach conflict recovery through an anon fallback when service role privileges are unavailable', async () => {
    const supabaseMocks = createProfilesSupabase({
      createError: { code: '23505', message: 'duplicate key value violates unique constraint profiles_pkey' },
      conflictProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'New User',
        email: user.email,
        membership_level: 'free',
        created_at: recentBootstrapCreatedAt,
      },
    });

    await expect(callProtectedProcedure(supabaseMocks, {
      hasSupabaseAdminPrivileges: false,
    })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('profile_bootstrap_failed'),
    });

    expect(supabaseMocks.adminTableCalls).toEqual([]);
    expect(supabaseMocks.profileInserts).toEqual([]);
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toBeNull();
  });

  it('fails profile bootstrap clearly and removes the empty profile when opening grant ledger RPC fails', async () => {
    const supabaseMocks = createProfilesSupabase({
      rpcError: { message: 'permission denied for function atomic_apply_credit_ledger_entry' },
    });

    await expect(callProtectedProcedure(supabaseMocks)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('profile_bootstrap_failed'),
    });
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', expect.objectContaining({
      p_type: 'addition',
      p_idempotency_key: `opening_grant:${user.id}`,
    }));
    expect(supabaseMocks.profileDeletes).toEqual([
      {
        deleted: true,
        filters: [
          { field: 'id', value: user.id },
          { field: 'role', value: 'user' },
          { field: 'status', value: 'active' },
          { field: 'membership_level', value: 'free' },
          { field: 'credits', value: 0 },
        ],
      },
    ]);
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toBeNull();
  });

  it('keeps the profile when the opening grant ledger exists after an RPC response error', async () => {
    const supabaseMocks = createProfilesSupabase({
      rpcError: { message: 'postgrest response failed after commit' },
      committedOpeningGrantAfterRpcError: true,
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });
    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.profileDeletes).toEqual([]);
    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.creditTransactions).toEqual([
      expect.objectContaining({
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }),
    ]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 100,
    });
  });

  it('keeps retry available when the opening grant fails and the ledger lookup also fails', async () => {
    const supabaseMocks = createProfilesSupabase({
      rpcErrorSequence: [
        { message: 'permission denied before commit' },
        null,
      ],
      ledgerLookupErrorSequence: [
        { message: 'credit_transactions lookup unavailable' },
      ],
    });

    await expect(callProtectedProcedure(supabaseMocks)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('profile_bootstrap_failed'),
    });
    expect(supabaseMocks.profileDeletes).toEqual([]);
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 0,
      created_at: recentBootstrapCreatedAt,
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(2);
    expect(supabaseMocks.creditTransactions).toEqual([
      expect.objectContaining({
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }),
    ]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 100,
    });
  });

  it('does not delete an opening-granted profile when the ledger lookup fails after commit', async () => {
    const supabaseMocks = createProfilesSupabase({
      rpcError: { message: 'postgrest response failed after commit' },
      committedOpeningGrantAfterRpcError: true,
      ledgerLookupErrorSequence: [
        { message: 'credit_transactions lookup unavailable' },
      ],
    });

    await expect(callProtectedProcedure(supabaseMocks)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('profile_bootstrap_failed'),
    });

    expect(supabaseMocks.profileDeletes).toEqual([]);
    expect(supabaseMocks.creditTransactions).toEqual([
      expect.objectContaining({
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }),
    ]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 100,
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.creditTransactions).toHaveLength(1);
  });

  it('recovers a missing opening grant for a recent safe bootstrap profile', async () => {
    const supabaseMocks = createProfilesSupabase({
      existingProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'New User',
        email: user.email,
        membership_level: 'free',
        created_at: recentBootstrapCreatedAt,
      },
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.profileInserts).toEqual([]);
    expect(supabaseMocks.profileDeletes).toEqual([]);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.creditTransactions).toEqual([
      expect.objectContaining({
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }),
    ]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 100,
    });
  });

  it('does not duplicate an existing opening grant while recovering a bootstrap profile', async () => {
    const supabaseMocks = createProfilesSupabase({
      existingProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'New User',
        email: user.email,
        membership_level: 'free',
        created_at: recentBootstrapCreatedAt,
      },
      creditTransactions: [{
        id: 'txn-existing-opening-grant',
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }],
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.creditTransactions).toHaveLength(1);
    expect(supabaseMocks.profileDeletes).toEqual([]);
  });

  it('skips existing-profile recovery when service role privileges are unavailable', async () => {
    const supabaseMocks = createProfilesSupabase({
      existingProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'New User',
        email: user.email,
        membership_level: 'free',
        created_at: recentBootstrapCreatedAt,
      },
    });

    await expect(callProtectedProcedure(supabaseMocks, {
      hasSupabaseAdminPrivileges: false,
    })).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.adminTableCalls).toEqual([]);
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.profileInserts).toEqual([]);
    expect(supabaseMocks.profileDeletes).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 0,
    });
  });

  it('keeps missing-profile bootstrap strict when service role privileges are unavailable', async () => {
    const supabaseMocks = createProfilesSupabase();

    await expect(callProtectedProcedure(supabaseMocks, {
      hasSupabaseAdminPrivileges: false,
    })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('profile_bootstrap_failed'),
    });

    expect(supabaseMocks.adminTableCalls).toEqual([]);
    expect(supabaseMocks.profileInserts).toEqual([]);
    expect(supabaseMocks.userProfileInserts).toEqual([]);
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toBeNull();
  });

  it('does not grant historical zero-credit profiles that are outside the bootstrap recovery window', async () => {
    const supabaseMocks = createProfilesSupabase({
      existingProfile: {
        id: user.id,
        role: 'user',
        credits: 0,
        status: 'active',
        nickname: 'Existing User',
        email: user.email,
        membership_level: 'free',
        created_at: legacyProfileCreatedAt,
      },
    });

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 0,
    });
  });

  it('cleans up only when no opening grant ledger exists and lets retry grant once', async () => {
    const supabaseMocks = createProfilesSupabase({
      rpcErrorSequence: [
        { message: 'permission denied before commit' },
        null,
      ],
    });

    await expect(callProtectedProcedure(supabaseMocks)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining('profile_bootstrap_failed'),
    });
    expect(supabaseMocks.profileDeletes).toEqual([
      {
        deleted: true,
        filters: [
          { field: 'id', value: user.id },
          { field: 'role', value: 'user' },
          { field: 'status', value: 'active' },
          { field: 'membership_level', value: 'free' },
          { field: 'credits', value: 0 },
        ],
      },
    ]);
    expect(supabaseMocks.creditTransactions).toEqual([]);
    expect(supabaseMocks.getStoredProfile()).toBeNull();

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.profileInserts).toHaveLength(2);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(2);
    expect(supabaseMocks.creditTransactions).toEqual([
      expect.objectContaining({
        user_id: user.id,
        amount: 100,
        balance_before: 0,
        balance_after: 100,
        idempotency_key: `opening_grant:${user.id}`,
      }),
    ]);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 100,
    });
  });

  it('does not duplicate profile creation or opening grants on repeated bootstrap calls', async () => {
    const supabaseMocks = createProfilesSupabase();

    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });
    await expect(callProtectedProcedure(supabaseMocks)).resolves.toMatchObject({
      profileId: user.id,
      userRole: 'user',
    });

    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.userProfileInserts).toEqual([]);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
    expect(supabaseMocks.creditTransactions).toHaveLength(1);
    expect(supabaseMocks.getStoredProfile()).toMatchObject({
      id: user.id,
      credits: 100,
    });
  });

  it('ignores user metadata role, membership, and credits while bootstrapping a missing profile', async () => {
    const { router, protectedProcedure } = await import('./trpc');
    const supabaseMocks = createProfilesSupabase();
    const maliciousMetadataUser = {
      ...user,
      user_metadata: {
        ...user.user_metadata,
        role: 'admin',
        status: 'banned',
        membership_level: 'gold',
        credits: 999999,
      },
    };
    const testRouter = router({
      readProfileContext: protectedProcedure.query(({ ctx }) => ({
        profileId: ctx.profileId,
        userRole: ctx.userRole,
        userStatus: ctx.userStatus,
      })),
    });
    const caller = testRouter.createCaller({
      headers: new Headers(),
      supabase: supabaseMocks.userSupabase as any,
      supabasePublic: supabaseMocks.userSupabase as any,
      supabaseAdmin: supabaseMocks.adminSupabase as any,
      supabaseAuth: supabaseMocks.userSupabase as any,
      hasSupabaseAdminPrivileges: true,
      user: maliciousMetadataUser as any,
      authProvider: 'email',
      isEmailVerified: true,
    });

    await expect(caller.readProfileContext()).resolves.toEqual({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
    });
    expect(supabaseMocks.profileInserts[0]).toMatchObject({
      role: 'user',
      status: 'active',
      membership_level: 'free',
      credits: 0,
    });
  });

  it('returns user.getUserProfile after server-side bootstrap creates the profile', async () => {
    const { router } = await import('./trpc');
    const { userRouter } = await import('./routers/user');
    const supabaseMocks = createProfilesSupabase();
    const testRouter = router({ user: userRouter });
    const caller = testRouter.createCaller({
      headers: new Headers(),
      supabase: supabaseMocks.userSupabase as any,
      supabasePublic: supabaseMocks.userSupabase as any,
      supabaseAdmin: supabaseMocks.adminSupabase as any,
      supabaseAuth: supabaseMocks.userSupabase as any,
      hasSupabaseAdminPrivileges: true,
      user: user as any,
      authProvider: 'email',
      isEmailVerified: true,
    });

    await expect(caller.user.getUserProfile()).resolves.toMatchObject({
      id: user.id,
      email: user.email,
      nickname: 'New User',
      role: 'user',
      credits: 100,
      membership_level: 'free',
      status: 'active',
      auth_provider: 'email',
      email_verified: true,
    });
    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('returns credits.getBalance after server-side bootstrap creates the profile', async () => {
    const { router } = await import('./trpc');
    const { creditsRouter } = await import('./routers/credits');
    const supabaseMocks = createProfilesSupabase();
    const testRouter = router({ credits: creditsRouter });
    const caller = testRouter.createCaller({
      headers: new Headers(),
      supabase: supabaseMocks.userSupabase as any,
      supabasePublic: supabaseMocks.userSupabase as any,
      supabaseAdmin: supabaseMocks.adminSupabase as any,
      supabaseAuth: supabaseMocks.userSupabase as any,
      hasSupabaseAdminPrivileges: true,
      user: user as any,
      authProvider: 'email',
      isEmailVerified: true,
    });

    await expect(caller.credits.getBalance()).resolves.toEqual({
      credits: 100,
      creditsExpiringSoon: 0,
      creditsExpiryDate: null,
    });
    expect(supabaseMocks.profileInserts).toHaveLength(1);
    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary protected profile reads on the user-scoped Supabase client', async () => {
    const supabaseMocks = createProfilesSupabase({
      existingProfile: {
        id: user.id,
        role: 'admin',
        credits: 250,
        status: 'active',
        nickname: 'Existing User',
        email: user.email,
      },
    });

    const result = await callProtectedProcedure(supabaseMocks);

    expect(result).toEqual({
      profileId: user.id,
      userRole: 'admin',
      userStatus: 'active',
      supabaseIsUserScoped: true,
    });
    expect(supabaseMocks.profileUpdates).toEqual([]);
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
  });
});
