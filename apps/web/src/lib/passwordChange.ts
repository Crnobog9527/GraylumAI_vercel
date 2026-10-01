import type { AuthCaptchaOptions } from '@/lib/authCaptcha';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { classifyPasswordUpdateError, validateNewPassword } from '@/lib/passwordRecovery';

// Changing the password while signed in (profile security card). Owner 2026-10-01: accounts linked
// to Google may change their password here too.
//
// GoTrue (v2.197.0, checked locally) shows no difference between a Google account that never set a
// password and one that set it later through a reset email: providers and identities both stay
// ['google'], and a sign-in with any password answers invalid_credentials for the first. Only the
// password stored on the server differs. So the page never guesses: every account with an email
// gets the entry, the current password is always checked first, and an account without one is
// pointed to setting it through the reset email.

export const SET_PASSWORD_BY_EMAIL_HINT = '还没有设置过密码？可以通过邮件设置。';

// The check never got an answer about the password (no response, or a server or gateway error):
// saying "wrong password" here would send the visitor in the wrong direction.
export const REAUTH_UNAVAILABLE_MESSAGE = '网络异常或服务暂时不可用，没有完成当前密码验证，请稍后重试。';

export const REAUTH_FAILED_MESSAGE =
  '当前密码验证失败，请重新输入。如果你一直用 Google 登录、还没有设置过密码，请通过邮件设置。';

export type PasswordChangeEntry = { available: boolean; description: string };

export function passwordChangeEntry(user: { email?: string; auth_provider?: string }): PasswordChangeEntry {
  if (!user.email) return { available: false, description: '当前账号没有邮箱，无法设置或修改密码。' };
  if (user.auth_provider === 'google') {
    return { available: true, description: '验证当前密码后可以修改密码。一直用 Google 登录、还没有设置过密码的，可以通过邮件设置。' };
  }
  return { available: true, description: '验证当前密码后可以修改密码。' };
}

export type PasswordChangeForm = { current: string; next: string; confirm: string };

export type PasswordChangeDeps = {
  captcha: () => Promise<AuthCaptchaOptions>;
  signInWithPassword: (credentials: {
    email: string;
    password: string;
    options: AuthCaptchaOptions;
  }) => Promise<{ error: unknown }>;
  updatePassword: (password: string) => Promise<{ error: unknown }>;
};

export type PasswordChangeResult = { ok: true } | { ok: false; message: string };

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

function errorStatus(error: unknown) {
  return error && typeof error === 'object' && 'status' in error ? error.status : null;
}

function reauthFailureMessage(error: unknown) {
  const status = errorStatus(error);
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
  if (errorCode(error) === 'captcha_failed') return '人机验证没有通过，请重试。';
  if (status === 429) return '操作太频繁，请稍后再试。';
  // auth-js reports a failed request as status 0 and gateway errors (502/503/504/520-524/530) as
  // AuthRetryableFetchError; a call that throws instead is no answer either.
  if (name === 'AuthRetryableFetchError' || status === 0 || (typeof status === 'number' && status >= 500)
    || error instanceof TypeError) {
    return REAUTH_UNAVAILABLE_MESSAGE;
  }
  return REAUTH_FAILED_MESSAGE;
}

// The current password is checked by signing in with it before anything changes; a failed check
// never reaches the update.
export async function changePasswordWithReauth(
  deps: PasswordChangeDeps,
  email: string | undefined,
  form: PasswordChangeForm,
): Promise<PasswordChangeResult> {
  if (!form.current || !form.next || !form.confirm) return { ok: false, message: '请完整填写当前密码和新密码。' };
  const invalid = validateNewPassword(form.next, form.confirm);
  if (invalid) return { ok: false, message: invalid };
  if (!email) return { ok: false, message: '当前会话缺少邮箱信息，无法修改密码。' };

  let captchaOptions: AuthCaptchaOptions;
  try {
    captchaOptions = await deps.captcha();
  } catch (error) {
    return { ok: false, message: getSafeErrorMessage(error, '人机验证未完成，请重试。') };
  }

  const reauth = await deps.signInWithPassword({ email, password: form.current, options: captchaOptions })
    .catch(error => ({ error }));
  if (reauth.error) return { ok: false, message: reauthFailureMessage(reauth.error) };

  const update = await deps.updatePassword(form.next).catch(error => ({ error }));
  if (update.error) {
    const failure = classifyPasswordUpdateError(update.error);
    return { ok: false, message: failure.kind === 'session' ? '登录状态已失效，请重新登录后再试。' : failure.message };
  }
  return { ok: true };
}
