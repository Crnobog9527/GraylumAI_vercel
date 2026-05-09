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
    const fallbackClient = { role: 'anon-fallback-client' };
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    createClientMock
      .mockReturnValueOnce(publicClient)
      .mockReturnValueOnce(fallbackClient);

    const { createTRPCContext } = await import('./trpc');
    const ctx = await createTRPCContext({
      headers: new Headers(),
    });

    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(ctx.supabase).toBe(publicClient);
    expect(ctx.supabasePublic).toBe(publicClient);
    expect(ctx.supabaseAdmin).toBe(fallbackClient);
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

  function createProfilesSupabase(options: {
    existingProfile?: Record<string, unknown> | null;
    createError?: { code?: string; message?: string } | null;
    rpcError?: { message: string } | null;
  } = {}) {
    const profileInserts: unknown[] = [];
    const profileUpdates: unknown[] = [];
    const profileDeletes: Array<{ field: string; value: unknown }> = [];
    const rpc = vi.fn().mockResolvedValue(
      options.rpcError
        ? { data: null, error: options.rpcError }
        : {
            data: [{
              transaction_id: '00000000-0000-4000-8000-0000000000aa',
              balance_before: 0,
              balance_after: 100,
              amount: 100,
              is_idempotent: false,
            }],
            error: null,
          },
    );

    const createdProfile = {
      id: user.id,
      role: 'user',
      credits: 0,
      status: 'active',
      nickname: 'New User',
      email: user.email,
    };

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
            profileInserts.push(payload);
            return builder;
          },
          update(payload: unknown) {
            state.operation = 'update';
            profileUpdates.push(payload);
            return builder;
          },
          async single() {
            if (state.operation === 'insert') {
              return options.createError
                ? { data: null, error: options.createError }
                : { data: createdProfile, error: null };
            }

            return options.existingProfile
              ? { data: options.existingProfile, error: null }
              : { data: null, error: { code: 'PGRST116', message: 'Not found' } };
          },
        };

        return builder;
      },
    };

    const adminSupabase = {
      rpc,
      from(table: string) {
        expect(table).toBe('profiles');
        const state: { eq?: { field: string; value: unknown } } = {};

        const builder = {
          delete() {
            return builder;
          },
          eq(field: string, value: unknown) {
            state.eq = { field, value };
            profileDeletes.push(state.eq);
            return builder;
          },
          then(
            onFulfilled: (value: { data: null; error: null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) {
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
      profileUpdates,
      profileDeletes,
    };
  }

  async function callProtectedProcedure(supabaseMocks: ReturnType<typeof createProfilesSupabase>) {
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
      hasSupabaseAdminPrivileges: true,
      user: user as any,
      authProvider: 'email',
      isEmailVerified: true,
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
        credits: 0,
      }),
    ]);
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
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      profileId: user.id,
      userRole: 'user',
      userStatus: 'active',
    });
  });

  it('does not issue an opening grant when profile creation fails', async () => {
    const supabaseMocks = createProfilesSupabase({
      createError: { code: '42501', message: 'permission denied' },
    });

    await expect(callProtectedProcedure(supabaseMocks)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(supabaseMocks.rpc).not.toHaveBeenCalled();
  });

  it('fails profile bootstrap and removes the empty profile when opening grant ledger RPC fails', async () => {
    const supabaseMocks = createProfilesSupabase({
      rpcError: { message: 'permission denied for function atomic_apply_credit_ledger_entry' },
    });

    await expect(callProtectedProcedure(supabaseMocks)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('atomic_apply_credit_ledger_entry', expect.objectContaining({
      p_type: 'addition',
      p_idempotency_key: `opening_grant:${user.id}`,
    }));
    expect(supabaseMocks.profileDeletes).toEqual([{ field: 'id', value: user.id }]);
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
