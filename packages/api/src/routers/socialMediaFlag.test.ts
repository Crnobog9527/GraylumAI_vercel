/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { socialMediaFlagRouter } from './socialMediaFlag';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(role = 'admin', options: { missing?: boolean; readError?: boolean } = {}) {
  const module = { id: id(2), social_media_related: false };
  const writes: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    let patch: Record<string, unknown> | undefined, expected: unknown;
    const q = {
      select() { return q; },
      eq(field: string, value: unknown) { if (field === 'social_media_related') expected = value; return q; },
      update(value: Record<string, unknown>) { patch = value; return q; },
      async maybeSingle() {
        if (table !== 'modules') throw new Error('Unexpected table');
        if (options.readError) return { data: null, error: { message: 'relation "modules" secret detail' } };
        return { data: options.missing ? null : { ...module }, error: null };
      },
      async single() { return { data: { id: id(1), role, status: 'active', credits: 0 }, error: null }; },
      then(resolve: (v: unknown) => unknown) {
        if (!patch) throw new Error('Unexpected query');
        if (expected !== module.social_media_related) return Promise.resolve(resolve({ data: [], error: null }));
        writes.push(patch); module.social_media_related = patch.social_media_related as boolean;
        return Promise.resolve(resolve({ data: [{ id: module.id }], error: null }));
      },
    }; return q;
  } };
  const caller = socialMediaFlagRouter.createCaller({ headers: new Headers(),
    user: role === 'anonymous' ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
  return { caller, module, writes };
}
it('admin reads the default (off), turns it on and off again', async () => {
  const f = fixture();
  expect(await f.caller.get({ moduleId: f.module.id })).toEqual({ moduleId: f.module.id, socialMediaRelated: false });
  expect(await f.caller.update({ moduleId: f.module.id, socialMediaRelated: true, expectedSocialMediaRelated: false }))
    .toEqual({ moduleId: f.module.id, socialMediaRelated: true });
  expect(await f.caller.update({ moduleId: f.module.id, socialMediaRelated: false, expectedSocialMediaRelated: true }))
    .toEqual({ moduleId: f.module.id, socialMediaRelated: false });
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toMatchObject({ social_media_related: true });
  expect(typeof f.writes[0]!.updated_at).toBe('string');
});
it('a page holding an older value cannot overwrite a newer one', async () => {
  const f = fixture();
  await f.caller.update({ moduleId: f.module.id, socialMediaRelated: true, expectedSocialMediaRelated: false });
  await expect(f.caller.update({ moduleId: f.module.id, socialMediaRelated: true, expectedSocialMediaRelated: false }))
    .rejects.toMatchObject({ code: 'CONFLICT', message: 'SOCIAL_MEDIA_FLAG_CONFLICT' });
  expect(f.writes).toHaveLength(1);
});
it('ordinary users and anonymous callers are refused without reading or writing', async () => {
  for (const role of ['user', 'anonymous']) {
    const f = fixture(role);
    await expect(f.caller.get({ moduleId: f.module.id })).rejects.toBeTruthy();
    await expect(f.caller.update({ moduleId: f.module.id, socialMediaRelated: true, expectedSocialMediaRelated: false }))
      .rejects.toBeTruthy();
    expect(f.writes).toEqual([]);
  }
});
it('missing modules and database failures map to stable codes without diagnostics', async () => {
  const missing = fixture('admin', { missing: true });
  await expect(missing.caller.get({ moduleId: missing.module.id }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND' });
  const broken = fixture('admin', { readError: true });
  await expect(broken.caller.update({ moduleId: broken.module.id, socialMediaRelated: true, expectedSocialMediaRelated: false }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'SOCIAL_MEDIA_FLAG_UNAVAILABLE' });
  expect(broken.writes).toEqual([]);
});
it('rejects unknown input fields', async () => {
  const f = fixture();
  await expect(f.caller.update({ moduleId: f.module.id, socialMediaRelated: true, expectedSocialMediaRelated: false,
    extra: 1 } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
