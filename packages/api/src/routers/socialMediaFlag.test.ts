/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { socialMediaFlagRouter } from './socialMediaFlag';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(role = 'admin', options: { missing?: boolean; readError?: boolean; positioningSkill?: boolean } = {}) {
  const module = { id: id(2), social_media_related: false, updated_at: '2026-10-12T00:00:00.000+00:00' };
  const writes: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    let patch: Record<string, unknown> | undefined, expected: unknown, version: unknown;
    const q = {
      select() { return q; },
      eq(field: string, value: unknown) { if (field === 'social_media_related') expected = value; if (field === 'updated_at') version = value; return q; },
      update(value: Record<string, unknown>) { patch = value; return q; },
      async maybeSingle() {
        if (table !== 'modules') throw new Error('Unexpected table');
        if (options.readError) return { data: null, error: { message: 'relation "modules" secret detail' } };
        return { data: options.missing ? null : { ...module }, error: null };
      },
      async single() { return { data: { id: id(1), role, status: 'active', credits: 0 }, error: null }; },
      then(resolve: (v: unknown) => unknown) {
        if (!patch) throw new Error('Unexpected query');
        // The auth middleware's own profile touch-up is not part of this flag.
        if (table !== 'modules') return Promise.resolve(resolve({ data: [], error: null }));
        // Stand-in for the 0219 database guard on the positioning Skill.
        if (options.positioningSkill && patch.social_media_related === true)
          return Promise.resolve(resolve({ data: null, error: { code: 'P0001', message: 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL' } }));
        if (expected !== module.social_media_related || version !== module.updated_at) return Promise.resolve(resolve({ data: [], error: null }));
        writes.push(patch); module.social_media_related = patch.social_media_related as boolean; module.updated_at = patch.updated_at as string;
        return Promise.resolve(resolve({ data: [{ id: module.id }], error: null }));
      },
    }; return q;
  } };
  const caller = socialMediaFlagRouter.createCaller({ headers: new Headers(),
    user: role === 'anonymous' ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
  // Saves from an editor that opened the module at `version` (default: the current one).
  const save = (on: boolean, expected: boolean, version = module.updated_at, extra: object = {}) => caller.update({
    moduleId: module.id, socialMediaRelated: on, expectedSocialMediaRelated: expected, expectedModuleUpdatedAt: version, ...extra } as never);
  return { caller, module, writes, save };
}
it('admin reads the default (off), turns it on and off again, and gets the new module version', async () => {
  const f = fixture();
  const opened = f.module.updated_at;
  expect(await f.caller.get({ moduleId: f.module.id }))
    .toEqual({ moduleId: f.module.id, socialMediaRelated: false, moduleUpdatedAt: opened });
  const on = await f.save(true, false);
  expect(on).toMatchObject({ moduleId: f.module.id, socialMediaRelated: true });
  expect(on.moduleUpdatedAt).not.toBe(opened);
  expect(await f.save(false, true, on.moduleUpdatedAt)).toMatchObject({ socialMediaRelated: false });
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toMatchObject({ social_media_related: true });
});
it('a page holding an older flag value cannot overwrite a newer one', async () => {
  const f = fixture();
  const opened = f.module.updated_at;
  await f.save(true, false);
  await expect(f.save(true, false, opened)).rejects.toMatchObject({ code: 'CONFLICT', message: 'SOCIAL_MEDIA_FLAG_CONFLICT' });
  expect(f.writes).toHaveLength(1);
});
it('refuses when the module changed elsewhere after the editor opened it, so the editor never adopts a hidden change', async () => {
  const f = fixture();
  const opened = f.module.updated_at;
  f.module.updated_at = '2026-10-12T01:00:00.000+00:00'; // e.g. a batch edit in another tab
  await expect(f.save(true, false, opened)).rejects.toMatchObject({ code: 'CONFLICT', message: 'SOCIAL_MEDIA_FLAG_CONFLICT' });
  expect(f.writes).toEqual([]);
});
it('ordinary users and anonymous callers are refused without reading or writing', async () => {
  for (const role of ['user', 'anonymous']) {
    const f = fixture(role);
    await expect(f.caller.get({ moduleId: f.module.id })).rejects.toBeTruthy();
    await expect(f.save(true, false)).rejects.toBeTruthy();
    expect(f.writes).toEqual([]);
  }
});
it('missing modules and database failures map to stable codes without diagnostics', async () => {
  const missing = fixture('admin', { missing: true });
  await expect(missing.caller.get({ moduleId: missing.module.id }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND' });
  const broken = fixture('admin', { readError: true });
  await expect(broken.save(true, false)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'SOCIAL_MEDIA_FLAG_UNAVAILABLE' });
  expect(broken.writes).toEqual([]);
});
it('rejects unknown or missing input fields', async () => {
  const f = fixture();
  await expect(f.save(true, false, f.module.updated_at, { extra: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(f.caller.update({ moduleId: f.module.id, socialMediaRelated: true, expectedSocialMediaRelated: false } as never))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
it('refuses to mark the positioning Skill, but always allows turning the flag off', async () => {
  const f = fixture('admin', { positioningSkill: true });
  await expect(f.save(true, false)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL' });
  expect(f.writes).toEqual([]);
  f.module.social_media_related = true;
  expect(await f.save(false, true)).toMatchObject({ moduleId: f.module.id, socialMediaRelated: false });
});
