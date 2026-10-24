/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger';
import { userRouter } from './user';

/** The profile row as the database holds it; the user-scoped client is only used by the auth middleware and the profile read. */
function setup(stored: string | null, opts: { admin?: boolean; failWrite?: boolean } = {}) {
  const row = { id: 'user-1', role: 'user', status: 'active', nickname: null, email: 'user@example.com', reply_language: stored };
  const writes: Array<{ value: Record<string, unknown>; onlyWhenNull: boolean }> = [];
  const targets: string[] = [];
  const supabase = { from(table: string) {
    if (table !== 'profiles') throw new Error(`Unexpected table ${table}`);
    // The auth middleware also records the login time through this client; that write is not under test.
    const done = Promise.resolve({ data: null, error: null });
    const q = { select: () => q, eq: () => q, update: () => q, single: async () => ({ data: { ...row }, error: null }),
      then: done.then.bind(done) };
    return q;
  } };
  const supabaseAdmin = { from(table: string) {
    if (table !== 'profiles') throw new Error(`Unexpected table ${table}`);
    let value: Record<string, unknown> | null = null, onlyWhenNull = false, ownRow = false, target = '';
    const run = async () => {
      if (!value) return { data: { reply_language: row.reply_language }, error: null };
      if (opts.failWrite) return { data: null, error: { code: '57014', message: 'private detail' } };
      writes.push({ value, onlyWhenNull });
      targets.push(target);
      if (!ownRow || (onlyWhenNull && row.reply_language !== null)) return { data: [], error: null };
      row.reply_language = value.reply_language as string;
      return { data: [{ reply_language: row.reply_language }], error: null };
    };
    const q = {
      update: (next: Record<string, unknown>) => { value = next; return q; },
      select: () => q,
      eq: (column: string, id: string) => { if (column === 'id') { target = id; ownRow = id === 'user-1'; } return q; },
      is: (column: string, target: unknown) => { if (column === 'reply_language' && target === null) onlyWhenNull = true; return q; },
      single: async () => { const result = await run(); return Array.isArray(result.data) ? { data: result.data[0] ?? null, error: result.error } : result; },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
    };
    return q;
  } };
  const caller = userRouter.createCaller({
    headers: new Headers(), user: { id: 'user-1', email: 'user@example.com', app_metadata: { provider: 'email' }, user_metadata: {} },
    isEmailVerified: true, authProvider: 'email', supabase, supabaseAuth: supabase, supabasePublic: {}, supabaseAdmin,
    hasSupabaseAdminPrivileges: opts.admin ?? true,
  } as never);
  return { caller, writes, targets, row };
}

describe('reply language setting (CHAT-LANGUAGE)', () => {
  it('the profile reports the language in effect and whether one was ever set', async () => {
    await expect(setup(null).caller.getUserProfile()).resolves.toMatchObject({ reply_language: 'zh-Hans', reply_language_set: false });
    await expect(setup('en').caller.getUserProfile()).resolves.toMatchObject({ reply_language: 'en', reply_language_set: true });
  });

  it.each(['zh-Hans', 'zh-Hant', 'en'] as const)('saves %s for the caller only, even without a nickname', async language => {
    const t = setup(null);
    await expect(t.caller.setReplyLanguage({ language })).resolves.toEqual({ language });
    expect(t.writes).toEqual([{ value: { reply_language: language }, onlyWhenNull: false }]);
    expect(t.row.reply_language).toBe(language);
  });

  it('writes only the reply language of the caller\'s own row, whatever else the request carries', async () => {
    const t = setup(null);
    const smuggled = { language: 'en', id: 'user-2', profileId: 'user-2', credits: 99999, role: 'admin', nickname: 'x' };
    await expect(t.caller.setReplyLanguage(smuggled as never)).resolves.toEqual({ language: 'en' });
    await expect(t.caller.applyEntryReplyLanguage(smuggled as never)).resolves.toEqual({ language: 'en' });
    expect(t.writes.map(w => Object.keys(w.value))).toEqual([['reply_language'], ['reply_language']]);
    expect(t.targets).toEqual(['user-1', 'user-1']);
  });

  it('refuses a language outside the three choices before writing anything', async () => {
    const t = setup(null);
    await expect(t.caller.setReplyLanguage({ language: 'fr' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(t.caller.applyEntryReplyLanguage({ language: 'zh-Hans' as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(t.writes).toEqual([]);
  });

  it('the sign-up entry language applies only while none was ever chosen, and never overrides a choice', async () => {
    const fresh = setup(null);
    await expect(fresh.caller.applyEntryReplyLanguage({ language: 'zh-Hant' })).resolves.toEqual({ language: 'zh-Hant' });
    expect(fresh.writes).toEqual([{ value: { reply_language: 'zh-Hant' }, onlyWhenNull: true }]);
    const chosen = setup('zh-Hans');
    await expect(chosen.caller.applyEntryReplyLanguage({ language: 'zh-Hant' })).resolves.toEqual({ language: 'zh-Hans' });
    expect(chosen.row.reply_language).toBe('zh-Hans');
  });

  it('without the service role, or when the write fails, says so without leaking the database error', async () => {
    await expect(setup(null, { admin: false }).caller.setReplyLanguage({ language: 'en' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const failing = setup(null, { failWrite: true });
    const error = await failing.caller.setReplyLanguage({ language: 'en' }).then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).toBe('语言设置保存失败，请稍后重试');
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private detail');
    logSpy.mockRestore();
  });
});
