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
