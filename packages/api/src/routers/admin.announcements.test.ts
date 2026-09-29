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

function createAdminCaller(onMutation: (payload: unknown) => void, storedBuilder?: unknown) {
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
        return storedBuilder ?? announcementMutationBuilder;
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
  it.each([
    'javascript:alert(1)', 'data:text/html,test', 'vbscript:msgbox(1)',
    '//example.com', '/\\example.com', 'https:example.com',
    'http://example.com', 'ftp://example.com', '', '   ',
  ])('rejects %j on both create and update before a write', async bannerLink => {
    const onMutation = vi.fn();
    const caller = createAdminCaller(onMutation);
    for (const request of [
      () => caller.createAnnouncement({ title: 'Banner', content: 'Content', bannerLink }),
      () => caller.updateAnnouncement({ id: announcementId, bannerLink }),
    ]) {
      await expect(request()).rejects.toMatchObject({
        code: 'BAD_REQUEST', message: expect.stringContaining('跳转链接'),
      });
    }
    expect(onMutation).not.toHaveBeenCalled();
  });

  it.each(['https://example.com/news', '/marketplace'])('saves %s on create and update', async bannerLink => {
    const onMutation = vi.fn();
    const caller = createAdminCaller(onMutation);
    await caller.createAnnouncement({ title: 'Banner', content: 'Content', bannerLink });
    await caller.updateAnnouncement({ id: announcementId, bannerLink });
    expect(onMutation).toHaveBeenCalledTimes(2);
    for (const [payload] of onMutation.mock.calls) {
      expect(payload).toMatchObject({ banner_link: bannerLink });
    }
  });

  it('allows creating a banner without a link', async () => {
    const onMutation = vi.fn();
    const caller = createAdminCaller(onMutation);

    await caller.createAnnouncement({
      title: 'Banner announcement',
      content: 'Content',
      bannerLink: null,
    });

    expect(onMutation).toHaveBeenCalledWith(
      expect.objectContaining({ banner_link: null, announcement_type: 'banner' }),
    );
  });

  it('rejects the retired homepage announcement type', async () => {
    const onMutation = vi.fn();
    const caller = createAdminCaller(onMutation);

    await expect(
      caller.createAnnouncement({
        title: 'Homepage announcement',
        content: 'Content',
        announcementType: 'homepage' as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.updateAnnouncement({
        id: announcementId,
        announcementType: 'homepage' as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(onMutation).not.toHaveBeenCalled();
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

// Model PostgREST equality filters against stored rows so regressions exercise
// the row that is actually changed, including callers omitting the type input.
function storedAnnouncement(type: 'homepage' | 'banner') {
  const rows: Record<string, unknown>[] = [{
    id: announcementId, announcement_type: type, title: 'Original', active: 'true',
  }];
  const filters = new Map<string, unknown>();
  let payload: Record<string, unknown> = {};
  let deleting = false;
  const execute = () => {
    const index = rows.findIndex(row => [...filters].every(([key, value]) => row[key] === value));
    if (index < 0) return { data: null, error: deleting ? null : { code: 'PGRST116' } };
    if (deleting) rows.splice(index, 1);
    else Object.assign(rows[index], payload);
    return { data: rows[index] ?? null, error: null };
  };
  const builder = {
    update(value: Record<string, unknown>) {
      payload = value;
      return this;
    },
    delete() {
      deleting = true;
      return this;
    },
    eq(key: string, value: unknown) {
      filters.set(key, value);
      return this;
    },
    select() { return this; },
    single() { return Promise.resolve(execute()); },
    then(resolve: (value: ReturnType<typeof execute>) => unknown) {
      return Promise.resolve(execute()).then(resolve);
    },
  };
  return { rows, caller: createAdminCaller(vi.fn(), builder) };
}

describe('retired homepage announcement rows', () => {
  it.each([undefined, 'banner'] as const)('cannot update or convert a homepage row with type %s', async type => {
    const { rows, caller } = storedAnnouncement('homepage');
    const original = structuredClone(rows);
    await expect(caller.updateAnnouncement({
      id: announcementId, title: 'Changed', active: 'false', announcementType: type,
    })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(rows).toEqual(original);
  });

  it('does not delete a homepage row using its retained ID', async () => {
    const { rows, caller } = storedAnnouncement('homepage');
    const original = structuredClone(rows);
    await caller.deleteAnnouncement({ id: announcementId });
    expect(rows).toEqual(original);
  });

  it('still updates banner rows', async () => {
    const { rows, caller } = storedAnnouncement('banner');
    await caller.updateAnnouncement({ id: announcementId, title: 'Updated', active: 'false' });
    expect(rows[0]).toMatchObject({ title: 'Updated', active: 'false', announcement_type: 'banner' });
  });

  it('still deletes banner rows', async () => {
    const { rows, caller } = storedAnnouncement('banner');
    await caller.deleteAnnouncement({ id: announcementId });
    expect(rows).toEqual([]);
  });
});
