import { sanitizeRedirectTarget } from '@/lib/auth';
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

// Where GoTrue sends an email or OAuth link back to. `next` goes through the same sanitizer the
// callback applies, so a landing's error or code parameters never ride along to the next page.
// `flow=oauth` marks a Google sign-in; it only picks which fixed message a failed exchange shows.
export type AuthCallbackFlow = 'email' | 'oauth';

export function buildAuthCallbackUrl(origin: string, next: string, flow: AuthCallbackFlow = 'email') {
  const url = new URL('/auth/callback', origin);
  url.searchParams.set('next', sanitizeRedirectTarget(next));
  if (flow === 'oauth') url.searchParams.set('flow', 'oauth');
  return url.toString();
}

export function parseAuthCallbackFlow(value: string | null): AuthCallbackFlow {
  return value === 'oauth' ? 'oauth' : 'email';
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

// What a URL fragment from an email link means. Links sent without PKCE (resent confirmations)
// put either an error or implicit-grant tokens there. The app's clients use PKCE, which rejects
// such tokens, and they are never turned into a session here: a crafted link could otherwise sign
// the visitor into someone else's account. A confirmed sign-up only gets a fixed "please log in".
export type FragmentOutcome = CallbackErrorRoute | { to: 'verified' } | { to: 'discard' };

export const EMAIL_VERIFIED_LOGIN_MESSAGE = '邮箱已验证，请登录。';

export function readAuthFragment(hash: string): FragmentOutcome {
  if (!hash.startsWith('#')) return null;
  const params = new URLSearchParams(hash.slice(1));
  const error = routeCallbackError(params);
  if (error) return error;
  if (params.has('access_token') || params.has('refresh_token')) {
    return params.get('type') === 'signup' ? { to: 'verified' } : { to: 'discard' };
  }
  return null;
}

// /login?error=<code>. The page shows fixed text for known codes and ignores any other value, so a
// crafted link cannot put its own words on the login page.
export type LoginErrorCode = 'callback_failed' | 'link_needs_login' | 'oauth_incomplete';

export const LOGIN_ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  callback_failed: '登录验证失败，请稍后重试。',
  // /verify already confirmed the email before the code exchange failed in this browser.
  link_needs_login: '如果你刚点击了验证邮件，邮箱可能已经验证成功，请直接用密码登录。',
  // A Google sign-in verifies no email and the account may have no password: just retry Google.
  oauth_incomplete: 'Google 登录没有完成，请重新点击 Google 登录。',
};

export function loginErrorMessage(value: string | null): string | null {
  return value && Object.hasOwn(LOGIN_ERROR_MESSAGES, value) ? LOGIN_ERROR_MESSAGES[value as LoginErrorCode] : null;
}

// A PKCE code exchange that failed because this browser does not hold the verifier the link was
// issued for: opened in another browser or device, or a newer flow replaced the verifier here.
const VERIFIER_EXCHANGE_ERROR_CODES = new Set([
  'pkce_code_verifier_not_found',
  'bad_code_verifier',
  'flow_state_not_found',
  'flow_state_expired',
]);

export function classifyCodeExchangeError(error: unknown, flow: AuthCallbackFlow = 'email'): LoginErrorCode {
  const code = errorCode(error);
  const verifierMismatch = VERIFIER_EXCHANGE_ERROR_CODES.has(code)
    || (!code && /code verifier|code challenge/i.test(getErrorMessageText(error)));
  if (!verifierMismatch) return 'callback_failed';
  return flow === 'oauth' ? 'oauth_incomplete' : 'link_needs_login';
}

export const RESEND_RATE_LIMIT_MESSAGE = '发送太频繁，请稍后再试。';
const RATE_LIMIT_ERROR_CODES = new Set(['over_email_send_rate_limit', 'over_request_rate_limit']);

export function resendErrorMessage(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
  if (status === 429 || RATE_LIMIT_ERROR_CODES.has(errorCode(error))) return RESEND_RATE_LIMIT_MESSAGE;
  return getSafeErrorMessage(error, '验证邮件发送失败，请稍后重试。');
}

// The verify page cannot read verification status without a session in this browser.
export const VERIFY_NEEDS_LOGIN_MESSAGE = '请登录后查看验证状态。';
