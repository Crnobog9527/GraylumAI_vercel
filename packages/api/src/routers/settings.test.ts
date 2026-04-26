import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { getPublicReadClient, settingsRouter } from './settings';

function createQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
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
