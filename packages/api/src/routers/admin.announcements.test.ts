import { describe, expect, it, vi } from 'vitest';

import { adminRouter } from './admin';

const announcementId = '00000000-0000-4000-8000-000000000271';

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

function createAdminCaller(onMutation: (payload: unknown) => void) {
  const userScopedSupabase = {
    from(table: string) {
      if (table === 'profiles') {
        return createSingleQueryBuilder(
          Promise.resolve({
            data: {
              id: 'admin-user',
              role: 'admin',
              status: 'active',
              nickname: 'Admin',
              email: 'admin@example.com',
            },
            error: null,
          }),
        );
      }

      throw new Error(`Unexpected user-scoped table ${table}`);
    },
  };

  const announcementMutationBuilder = {
    insert(payload: unknown) {
      onMutation(payload);
      return this;
    },
    update(payload: unknown) {
      onMutation(payload);
      return this;
    },
    eq() {
      return this;
    },
    select() {
      return this;
    },
    single() {
      return Promise.resolve({ data: { id: announcementId }, error: null });
    },
  };

  const adminSupabase = {
    from(table: string) {
      if (table === 'announcements') {
        return announcementMutationBuilder;
      }

      throw new Error(`Unexpected admin table ${table}`);
    },
  };

  return adminRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'admin-user',
      email: 'admin@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase: userScopedSupabase,
    supabaseAuth: userScopedSupabase,
    supabasePublic: {},
    supabaseAdmin: adminSupabase,
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('adminRouter announcement link writes', () => {
  it('normalizes a blank create link to banner_link null', async () => {
    const onMutation = vi.fn();
    const caller = createAdminCaller(onMutation);

    await caller.createAnnouncement({
      title: 'Homepage announcement',
      content: 'Content',
      announcementType: 'homepage',
      bannerLink: '   ',
    });

    expect(onMutation).toHaveBeenCalledWith(
      expect.objectContaining({ banner_link: null }),
    );
  });

  it('writes banner_link as null when explicitly clearing a link', async () => {
    const onMutation = vi.fn();
    const caller = createAdminCaller(onMutation);

    await caller.updateAnnouncement({
      id: announcementId,
      bannerLink: null,
    });

    expect(onMutation).toHaveBeenCalledWith(
      expect.objectContaining({ banner_link: null }),
    );
  });

  it('does not touch banner_link when it is omitted from an update', async () => {
    const onMutation = vi.fn();
    const caller = createAdminCaller(onMutation);

    await caller.updateAnnouncement({
      id: announcementId,
      title: 'Updated title',
    });

    const payload = onMutation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({ title: 'Updated title' });
    expect(payload).not.toHaveProperty('banner_link');
  });
});
