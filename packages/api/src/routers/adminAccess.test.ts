/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adminAccessRouter } from './adminAccess';

/** The service-role client of this request: any use of it fails the test, since the access check must read no data. */
function untouchedAdminClient() {
  const used: string[] = [];
  const refuse = (what: string) => (...args: unknown[]) => {
    used.push(`${what}:${String(args[0])}`);
    throw new Error(`admin.access must not read data (${what} ${String(args[0])})`);
  };
  return { client: { from: refuse('from'), rpc: refuse('rpc') }, used };
}

function createCaller(role: 'admin' | 'user', adminClient: unknown) {
  const profile = { id: 'caller', role, status: 'active', nickname: 'C', email: 'c@example.com' };
  const userScoped = {
    from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }) }),
  };
  return adminAccessRouter.createCaller({
    headers: new Headers(),
    user: { id: 'caller', email: 'c@example.com', app_metadata: {}, user_metadata: {} },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: userScoped,
    supabaseAuth: userScoped,
    supabasePublic: {},
    supabaseAdmin: adminClient,
    hasSupabaseAdminPrivileges: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test context carries only what the procedure chain reads.
  } as any);
}

describe('admin.access (the admin layout guard)', () => {
  it('lets an admin in without reading any table', async () => {
    const { client, used } = untouchedAdminClient();
    await expect(createCaller('admin', client).access()).resolves.toEqual({ admin: true });
    expect(used).toEqual([]);
  });

  it('refuses a signed-in user who is not an admin', async () => {
    const { client, used } = untouchedAdminClient();
    await expect(createCaller('user', client).access()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(used).toEqual([]);
  });
});

describe('admin.access is reachable under the admin router', () => {
  // Read from the source: importing the whole app router here costs seconds of cold transform for one line.
  it('is merged into the admin router, next to the existing admin procedures', () => {
    const root = readFileSync(fileURLToPath(new URL('../root.ts', import.meta.url)), 'utf8');
    expect(root).toContain('admin: mergeRouters(adminRouter, adminAccessRouter),');
  });
});
