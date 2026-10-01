import type { User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { getAuthProvider } from './auth';
import {
  changePasswordWithReauth,
  passwordChangeEntry,
  REAUTH_FAILED_MESSAGE,
  type PasswordChangeDeps,
} from './passwordChange';

// What GoTrue v2.197.0 returns for each kind of account (checked against a local GoTrue): a Google
// account that set a password through a reset email looks exactly like one that never did.
const accounts = {
  emailOnly: { providers: ['email'], identities: ['email'], hasPassword: true },
  googleOnly: { providers: ['google'], identities: ['google'], hasPassword: false },
  googleWithPassword: { providers: ['google'], identities: ['google'], hasPassword: true },
  emailThenGoogle: { providers: ['email', 'google'], identities: ['email', 'google'], hasPassword: true },
} as const;
type Account = (typeof accounts)[keyof typeof accounts];

const userOf = (account: Account) => ({
  id: 'u1',
  email: 'a@example.test',
  app_metadata: { provider: account.providers[0], providers: [...account.providers] },
  identities: account.identities.map(provider => ({ provider })),
}) as unknown as User;

const CURRENT = 'current-password';
// A GoTrue-like sign-in: only an account that has a password, given that password, gets in.
const depsFor = (account: Account) => {
  const signInWithPassword = vi.fn<PasswordChangeDeps['signInWithPassword']>(async ({ password }) => (
    account.hasPassword && password === CURRENT
      ? { error: null }
      : { error: Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials', status: 400 }) }
  ));
  const deps = {
    captcha: vi.fn(async () => ({ captchaToken: 'token' })),
    signInWithPassword,
    updatePassword: vi.fn(async () => ({ error: null as unknown })),
  };
  return deps;
};
const form = (current = CURRENT) => ({ current, next: 'new-password-1', confirm: 'new-password-1' });

describe('password change entry', () => {
  it.each(Object.entries(accounts))('is offered to a %s account, never hidden by provider', (_, account) => {
    const entry = passwordChangeEntry({ email: 'a@example.test', auth_provider: getAuthProvider(userOf(account)) });
    expect(entry.available).toBe(true);
  });

  it('cannot tell a Google account with a password from one without, so both get the same entry', () => {
    const withPassword = passwordChangeEntry({ email: 'a@example.test', auth_provider: getAuthProvider(userOf(accounts.googleWithPassword)) });
    const without = passwordChangeEntry({ email: 'a@example.test', auth_provider: getAuthProvider(userOf(accounts.googleOnly)) });
    expect(withPassword).toEqual(without);
    expect(without.description).toContain('通过邮件设置');
  });

  it('is not offered without an email', () => {
    expect(passwordChangeEntry({ auth_provider: 'google' })).toMatchObject({ available: false });
  });
});

describe('changePasswordWithReauth', () => {
  it.each([
    ['email-only', accounts.emailOnly],
    ['Google with a password', accounts.googleWithPassword],
    ['email then Google', accounts.emailThenGoogle],
  ])('changes the password of a %s account after the current password checks out', async (_, account) => {
    const deps = depsFor(account);
    expect(await changePasswordWithReauth(deps, 'a@example.test', form())).toEqual({ ok: true });
    expect(deps.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@example.test', password: CURRENT, options: { captchaToken: 'token' },
    });
    expect(deps.updatePassword).toHaveBeenCalledExactlyOnceWith('new-password-1');
  });

  it('never changes anything for a Google account without a password, and points to the email route', async () => {
    const deps = depsFor(accounts.googleOnly);
    expect(await changePasswordWithReauth(deps, 'a@example.test', form('anything-at-all'))).toEqual({
      ok: false, message: REAUTH_FAILED_MESSAGE,
    });
    expect(REAUTH_FAILED_MESSAGE).toContain('通过邮件设置');
    expect(deps.updatePassword).not.toHaveBeenCalled();
  });

  it.each(Object.entries(accounts))('rejects a wrong current password for a %s account without changing it', async (_, account) => {
    const deps = depsFor(account);
    expect(await changePasswordWithReauth(deps, 'a@example.test', form('wrong-password'))).toEqual({
      ok: false, message: REAUTH_FAILED_MESSAGE,
    });
    expect(deps.updatePassword).not.toHaveBeenCalled();
  });

  it('checks the form before any human check or sign-in', async () => {
    const deps = depsFor(accounts.emailOnly);
    expect(await changePasswordWithReauth(deps, 'a@example.test', { current: '', next: 'x', confirm: 'x' }))
      .toEqual({ ok: false, message: '请完整填写当前密码和新密码。' });
    expect(await changePasswordWithReauth(deps, 'a@example.test', { current: CURRENT, next: 'short', confirm: 'short' }))
      .toEqual({ ok: false, message: '新密码至少需要 8 位字符。' });
    expect(await changePasswordWithReauth(deps, undefined, form())).toMatchObject({ ok: false });
    expect(deps.captcha).not.toHaveBeenCalled();
    expect(deps.signInWithPassword).not.toHaveBeenCalled();
  });

  it('stops at a failed human check, a refused token or too many attempts', async () => {
    const deps = depsFor(accounts.emailOnly);
    deps.captcha.mockRejectedValueOnce(new Error('人机验证已取消，请重试。'));
    expect(await changePasswordWithReauth(deps, 'a@example.test', form())).toEqual({ ok: false, message: '人机验证已取消，请重试。' });
    deps.signInWithPassword.mockResolvedValueOnce({ error: Object.assign(new Error('raw'), { code: 'captcha_failed', status: 400 }) });
    expect(await changePasswordWithReauth(deps, 'a@example.test', form())).toEqual({ ok: false, message: '人机验证没有通过，请重试。' });
    deps.signInWithPassword.mockResolvedValueOnce({ error: Object.assign(new Error('raw'), { code: 'over_request_rate_limit', status: 429 }) });
    expect(await changePasswordWithReauth(deps, 'a@example.test', form())).toEqual({ ok: false, message: '操作太频繁，请稍后再试。' });
    deps.signInWithPassword.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await changePasswordWithReauth(deps, 'a@example.test', form())).toEqual({ ok: false, message: REAUTH_FAILED_MESSAGE });
    expect(deps.updatePassword).not.toHaveBeenCalled();
  });

  it('shows fixed texts when the update itself fails, never the provider text', async () => {
    const deps = depsFor(accounts.emailOnly);
    deps.updatePassword.mockResolvedValueOnce({ error: Object.assign(new Error('raw'), { code: 'same_password', status: 422 }) });
    expect(await changePasswordWithReauth(deps, 'a@example.test', form())).toEqual({ ok: false, message: '新密码不能和原来的密码相同。' });
    deps.updatePassword.mockResolvedValueOnce({ error: Object.assign(new Error('raw'), { code: 'session_not_found', status: 403 }) });
    expect(await changePasswordWithReauth(deps, 'a@example.test', form())).toEqual({ ok: false, message: '登录状态已失效，请重新登录后再试。' });
    deps.updatePassword.mockRejectedValueOnce(new Error('New password should be different'));
    const thrown = await changePasswordWithReauth(deps, 'a@example.test', form());
    expect(thrown).toMatchObject({ ok: false });
    expect(JSON.stringify(thrown)).not.toContain('should be different');
  });
});
