/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { voiceFlagRouter } from './voiceFlag';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(role = 'admin', options: { missing?: boolean; readError?: boolean; racingSave?: boolean } = {}) {
  const module = { id: id(2), uses_user_voice: false, updated_at: '2026-10-12T00:00:00.000+00:00' };
  const writes: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    let patch: Record<string, unknown> | undefined, expected: unknown, version: unknown;
    const q = {
      select() { return q; },
      eq(field: string, value: unknown) { if (field === 'uses_user_voice') expected = value; if (field === 'updated_at') version = value; return q; },
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
        if (expected !== module.uses_user_voice || version !== module.updated_at) return Promise.resolve(resolve({ data: [], error: null }));
        writes.push(patch); module.uses_user_voice = patch.uses_user_voice as boolean; module.updated_at = patch.updated_at as string;
        const written = { ...module };
        // Another tab saves right after this write; a later read would see its version, not ours.
        if (options.racingSave) module.updated_at = '2026-10-12T09:00:00.000+00:00';
        return Promise.resolve(resolve({ data: [written], error: null }));
      },
    }; return q;
  } };
  const caller = voiceFlagRouter.createCaller({ headers: new Headers(),
    user: role === 'anonymous' ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
  // Saves from an editor that opened the module at `version` (default: the current one).
  const save = (on: boolean, expected: boolean, version = module.updated_at, extra: object = {}) => caller.update({
    moduleId: module.id, usesUserVoice: on, expectedUsesUserVoice: expected, expectedModuleUpdatedAt: version, ...extra } as never);
  return { caller, module, writes, save };
}
it('admin reads the default (off), turns it on and off again, and gets the new module version', async () => {
  const f = fixture();
  const opened = f.module.updated_at;
  expect(await f.caller.get({ moduleId: f.module.id }))
    .toEqual({ moduleId: f.module.id, usesUserVoice: false, moduleUpdatedAt: opened });
  const on = await f.save(true, false);
  expect(on).toMatchObject({ moduleId: f.module.id, usesUserVoice: true });
  expect(on.moduleUpdatedAt).not.toBe(opened);
  expect(await f.save(false, true, on.moduleUpdatedAt)).toMatchObject({ usesUserVoice: false });
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toMatchObject({ uses_user_voice: true });
});
it('a page holding an older flag value cannot overwrite a newer one', async () => {
  const f = fixture();
  const opened = f.module.updated_at;
  await f.save(true, false);
  await expect(f.save(true, false, opened)).rejects.toMatchObject({ code: 'CONFLICT', message: 'VOICE_FLAG_CONFLICT' });
  expect(f.writes).toHaveLength(1);
});
it('refuses when the module changed elsewhere after the editor opened it, so the editor never adopts a hidden change', async () => {
  const f = fixture();
  const opened = f.module.updated_at;
  f.module.updated_at = '2026-10-12T01:00:00.000+00:00'; // e.g. a batch edit in another tab
  await expect(f.save(true, false, opened)).rejects.toMatchObject({ code: 'CONFLICT', message: 'VOICE_FLAG_CONFLICT' });
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
  await expect(fixture('admin', { missing: true }).caller.get({ moduleId: id(2) })).rejects.toMatchObject({ message: 'VOICE_FLAG_MODULE_NOT_FOUND' });
  await expect(fixture('admin', { readError: true }).caller.get({ moduleId: id(2) })).rejects.toMatchObject({ message: 'VOICE_FLAG_UNAVAILABLE' });
});
