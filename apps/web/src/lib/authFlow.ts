import { getErrorMessageText, getSafeErrorMessage } from '@/lib/safe-error-message';

// Email sign-in outcomes the login page acts on. GoTrue answers a wrong password and an unknown
// email with the same invalid_credentials, so offering the resend link there reveals nothing.
export type LoginFailure =
  | { kind: 'unconfirmed' }
  | { kind: 'error'; message: string; offerResend: boolean };

export const INVALID_CREDENTIALS_MESSAGE = '邮箱或密码不正确，请检查后重试。';

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

export function classifyLoginError(error: unknown, fallback: string): LoginFailure {
  const code = errorCode(error);
  if (code === 'email_not_confirmed') return { kind: 'unconfirmed' };
  if (code === 'invalid_credentials') {
    return { kind: 'error', message: INVALID_CREDENTIALS_MESSAGE, offerResend: true };
  }
  // Older clients or proxies may drop the code; keep the previous text match only for that case.
  if (!code && /confirm|verified|verification|email/i.test(getErrorMessageText(error))) {
    return { kind: 'unconfirmed' };
  }
  return { kind: 'error', message: getSafeErrorMessage(error, fallback), offerResend: false };
}

// Why /verify-email was opened. Only these values are honored; anything else shows the default text.
export type VerifyReason = 'signup' | 'expired';

export const VERIFY_REASON_MESSAGES: Record<VerifyReason, string> = {
  // Same text whether or not the email already had an account, so sign-up never confirms that.
  signup: '验证邮件已发送，请点击邮件中的链接完成验证。如果这个邮箱之前注册过，请直接登录；重复注册不会修改原来的密码。',
  expired: '验证链接已失效或已被使用，请重新发送验证邮件。',
};

export function parseVerifyReason(value: string | null): VerifyReason | null {
  return value === 'signup' || value === 'expired' ? value : null;
}

export function buildVerifyEmailPath(email: string, redirect: string, reason?: VerifyReason) {
  const params = new URLSearchParams();
  if (email) params.set('email', email);
  params.set('redirect', redirect);
  if (reason) params.set('reason', reason);
  return `/verify-email?${params.toString()}`;
}

// Errors GoTrue appends to the email-link redirect. Only error_code values listed here route to the
// resend page; the provider's error_description is never shown. access_denied alone (for example a
// declined Google consent) is not an expired link, so it takes the generic login error instead.
const EXPIRED_LINK_ERROR_CODES = new Set(['otp_expired']);

export type CallbackErrorRoute = { to: 'verify-expired' } | { to: 'login-error' } | null;

export function routeCallbackError(params: URLSearchParams): CallbackErrorRoute {
  const code = params.get('error_code');
  if (code && EXPIRED_LINK_ERROR_CODES.has(code)) return { to: 'verify-expired' };
  if (code || params.has('error')) return { to: 'login-error' };
  return null;
}

// The same errors when GoTrue puts them in the URL fragment (links sent without PKCE).
export function routeFragmentError(hash: string): CallbackErrorRoute {
  return hash.startsWith('#') ? routeCallbackError(new URLSearchParams(hash.slice(1))) : null;
}

// /login?error=<code>. The page shows fixed text for known codes and ignores any other value, so a
// crafted link cannot put its own words on the login page.
export type LoginErrorCode = 'callback_failed';

export const LOGIN_ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  callback_failed: '登录验证失败，请稍后重试。',
};

export function loginErrorMessage(value: string | null): string | null {
  return value === 'callback_failed' ? LOGIN_ERROR_MESSAGES.callback_failed : null;
}
