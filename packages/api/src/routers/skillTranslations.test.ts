/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { skillTranslationsRouter } from './skillTranslations';
import { makeWorkflow } from '../services/__tests__/fixtures/artifacts';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Options = { missing?: boolean; readError?: boolean; unpublished?: boolean; badWorkflow?: boolean; stored?: unknown };
function fixture(role = 'admin', options: Options = {}) {
  const module = { id: id(2), display_translations: (options.stored ?? {}) as unknown, updated_at: '2026-10-16T00:00:00.000+00:00' };
  const workflow = { ...makeWorkflow(2, true), steps: makeWorkflow(2, true).steps.map((step, i) =>
    i === 0 ? { ...step, information: [{ id: 'goal', title: '目标', required: true }] } : step) };
  const writes: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    let patch: Record<string, unknown> | undefined, version: unknown;
    const q = {
      select() { return q; },
      eq(field: string, value: unknown) { if (field === 'updated_at') version = value; return q; },
      update(value: Record<string, unknown>) { patch = value; return q; },
      async maybeSingle() {
        if (table !== 'modules') throw new Error('Unexpected table');
        if (options.readError) return { data: null, error: { message: 'relation "modules" secret detail' } };
        return { data: options.missing ? null : { ...module }, error: null };
      },
      async single() { return { data: { id: id(1), role, status: 'active', credits: 0 }, error: null }; },
      then(resolve: (v: unknown) => unknown) {
        if (table === 'artifact_workflows') return Promise.resolve(resolve({ error: null,
          data: options.unpublished ? [] : [{ workflow: options.badWorkflow ? { steps: 'x' } : workflow }] }));
        if (!patch) throw new Error('Unexpected query');
        // The auth middleware's own profile touch-up is not part of this setting.
        if (table !== 'modules') return Promise.resolve(resolve({ data: [], error: null }));
        if (version !== module.updated_at) return Promise.resolve(resolve({ data: [], error: null }));
        writes.push(patch);
        module.display_translations = patch.display_translations; module.updated_at = patch.updated_at as string;
        return Promise.resolve(resolve({ data: [{ ...module }], error: null }));
      },
    }; return q;
  } };
  const caller = skillTranslationsRouter.createCaller({ headers: new Headers(),
    user: role === 'anonymous' ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
  const save = (translations: object, version = module.updated_at, extra: object = {}) => caller.update({
    moduleId: module.id, locale: 'en', translations, expectedModuleUpdatedAt: version, ...extra } as never);
  return { caller, module, writes, save };
}

it('admin reads the published labels, saves English, and gets the new module version', async () => {
  const f = fixture();
  const opened = await f.caller.get({ moduleId: f.module.id });
  expect(opened).toMatchObject({ moduleId: f.module.id, moduleUpdatedAt: f.module.updated_at, translations: {} });
  expect(opened.source?.steps.map(step => step.title)).toEqual(['需求确认', '对标分析']);
  expect(opened.source?.steps[0]!.fields).toEqual([{ id: 'goal', title: '目标' }]);
  const english = { reportTitle: { original: 'Confirmed strategy', text: 'Strategy' },
    steps: { 'step-0': { original: '需求确认', text: 'Your needs' } }, fields: { 'step-0': { goal: { original: '目标', text: 'Goal' } } } };
  const saved = await f.save(english);
  expect(saved.translations).toEqual({ en: english });
  expect(saved.moduleUpdatedAt).not.toBe(opened.moduleUpdatedAt);
  // Clearing every input removes the locale; the Chinese originals show again.
  expect((await f.save({}, saved.moduleUpdatedAt)).translations).toEqual({});
  expect(f.writes).toHaveLength(2);
});

it('refuses a save from an editor opened before another change, without writing', async () => {
  const f = fixture();
  const opened = f.module.updated_at;
  f.module.updated_at = '2026-10-16T01:00:00.000+00:00'; // e.g. the social-media flag saved in another tab
  await expect(f.save({ reportTitle: { original: 'Confirmed strategy', text: 'Strategy' } }, opened)).rejects.toMatchObject({ code: 'CONFLICT', message: 'SKILL_TRANSLATIONS_CONFLICT' });
  expect(f.writes).toEqual([]);
});

it('refuses keys that are not labels of the published workflow, and unpublished Skills', async () => {
  const f = fixture();
  const t = (original: string, text: string) => ({ original, text });
  // Unknown ids, and translations made for words the published Skill no longer uses (it was republished).
  for (const bad of [{ steps: { 'step-9': t('需求确认', 'Gone') } }, { fields: { 'step-1': { goal: t('目标', 'Goal') } } },
    { reportSections: { 不存在: 'X' } }, { steps: { 'step-0': t('旧的步骤名', 'Old') } }, { reportTitle: t('旧标题', 'Old') }])
    await expect(f.save(bad)).rejects.toMatchObject({ message: 'SKILL_TRANSLATIONS_UNKNOWN_KEY' });
  const unpublished = fixture('admin', { unpublished: true });
  expect((await unpublished.caller.get({ moduleId: unpublished.module.id })).source).toBeNull();
  await expect(unpublished.save({ reportTitle: t('Confirmed strategy', 'X') })).rejects.toMatchObject({ message: 'SKILL_TRANSLATIONS_NOT_PUBLISHED' });
  expect([...f.writes, ...unpublished.writes]).toEqual([]);
});

it('rejects malformed input before reading', async () => {
  const f = fixture();
  for (const extra of [{ locale: 'fr' }, { translations: { steps: { 'step-0': { original: '需求确认', text: 'a\nb' } } } }, { translations: { other: 'x' } }])
    await expect(f.save({}, f.module.updated_at, extra)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});

it('ordinary users and anonymous callers are refused without reading or writing', async () => {
  for (const role of ['user', 'anonymous']) {
    const f = fixture(role);
    await expect(f.caller.get({ moduleId: f.module.id })).rejects.toBeTruthy();
    await expect(f.save({ reportTitle: { original: 'Confirmed strategy', text: 'X' } })).rejects.toBeTruthy();
    expect(f.writes).toEqual([]);
  }
});

it('missing modules, bad stored data and database failures map to stable codes without diagnostics', async () => {
  await expect(fixture('admin', { missing: true }).caller.get({ moduleId: id(2) }))
    .rejects.toMatchObject({ message: 'SKILL_TRANSLATIONS_MODULE_NOT_FOUND' });
  for (const options of [{ readError: true }, { badWorkflow: true }]) {
    const error = await fixture('admin', options).caller.get({ moduleId: id(2) }).catch(e => e);
    expect(error.message).toBe('SKILL_TRANSLATIONS_UNAVAILABLE');
    expect(error.message).not.toContain('secret');
  }
  // Stored data that no longer parses reads as "no translations" instead of failing the editor.
  expect((await fixture('admin', { stored: { en: { title: 1 } } }).caller.get({ moduleId: id(2) })).translations).toEqual({});
});
