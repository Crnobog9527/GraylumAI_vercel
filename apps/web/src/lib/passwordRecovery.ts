import { buildAuthCallbackUrl, isVerifierMismatch } from '@/lib/authFlow';
import {
  ACCOUNT_UNAVAILABLE_MESSAGE, getErrorMessageText,
} from '@/lib/safe-error-message';

// Forgot-password flow: /forgot-password asks GoTrue for a reset email, the link goes through the
// shared /auth/callback (PKCE code exchange) and lands on /reset-password with a recovery session.
export const FORGOT_PASSWORD_PATH = '/forgot-password';
export const RESET_PASSWORD_PATH = '/reset-password';

export function buildRecoveryRedirectUrl(origin: string) {
  return buildAuthCallbackUrl(origin, RESET_PASSWORD_PATH, 'recovery');
}

// GoTrue answers an unknown email with success before looking further, so any result that only a
// registered email can produce (a failed send, the per-email send limit) must look exactly like
// success: same text, same cooldown. The text therefore also covers "nothing arrived".
export const RESET_EMAIL_SENT_MESSAGE =
  '如果这个邮箱已注册，你会收到一封重置密码的邮件。请在申请重置的同一个浏览器里打开邮件中的链接。'
  + '几分钟内没有收到时，请检查垃圾邮件文件夹，或在倒计时结束后重新申请。';

// Seconds the request button stays disabled after a request, so one page does not hit the limit.
export const RESET_REQUEST_COOLDOWN_SECONDS = 60;

export const RESET_CAPTCHA_FAILED_MESSAGE = '人机验证没有通过，请重试。';
export const RESET_RATE_LIMIT_MESSAGE = '请求太频繁，请稍后再试。';
export const RESET_NETWORK_MESSAGE = '网络异常，请检查网络后重试。';
export const RESET_INVALID_EMAIL_MESSAGE = '邮箱格式不正确，请检查后重试。';

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
}

function errorStatus(error: unknown) {
  return error && typeof error === 'object' && 'status' in error ? error.status : null;
}

function errorName(error: unknown) {
  return error && typeof error === 'object' && 'name' in error ? error.name : null;
}

// Only failures that happen the same way for every address get their own text: the human check,
// the per-visitor request limit (code over_request_rate_limit, or a 429 without a code), a request
// that never reached GoTrue, and a malformed address. Everything else counts as sent.
function accountIndependentFailure(error: unknown): string | null {
  const code = errorCode(error);
  const status = errorStatus(error);
  if (code === 'captcha_failed') return RESET_CAPTCHA_FAILED_MESSAGE;
  if (code === 'over_request_rate_limit' || (status === 429 && !code)) return RESET_RATE_LIMIT_MESSAGE;
  if (code === 'validation_failed' || code === 'email_address_invalid') return RESET_INVALID_EMAIL_MESSAGE;
  if (errorName(error) === 'AuthRetryableFetchError' || status === 0 || error instanceof TypeError) {
    return RESET_NETWORK_MESSAGE;
  }
  return null;
}

export type ResetRequestOutcome = { tone: 'success' | 'error'; message: string; cooldownSeconds: number };

export function resetRequestOutcome(error: unknown): ResetRequestOutcome {
  const failure = error ? accountIndependentFailure(error) : null;
  return failure
    ? { tone: 'error', message: failure, cooldownSeconds: 0 }
    : { tone: 'success', message: RESET_EMAIL_SENT_MESSAGE, cooldownSeconds: RESET_REQUEST_COOLDOWN_SECONDS };
}

// Why /forgot-password was opened again. Only these values are honored; the callback sets them.
export type RecoveryFailure = 'expired' | 'browser' | 'failed';

export const RECOVERY_FAILURE_MESSAGES: Record<RecoveryFailure, string> = {
  expired: '重置链接无效、已过期或已被使用，请重新申请。',
  // PKCE: the code can only be exchanged where the reset was requested.
  browser: '请在申请重置的同一个浏览器里打开邮件中的链接，或者在这里重新申请。',
  failed: '重置验证没有完成，请重新申请。',
};

export function parseRecoveryFailure(value: string | null): RecoveryFailure | null {
  return value === 'expired' || value === 'browser' || value === 'failed' ? value : null;
}

export function buildForgotPasswordPath(reason?: RecoveryFailure) {
  return reason ? `${FORGOT_PASSWORD_PATH}?reason=${reason}` : FORGOT_PASSWORD_PATH;
}

// A missing or different verifier means another browser. A used or expired flow state (for example
// the callback address opened again in the same browser) is an expired link instead.
const SPENT_FLOW_ERROR_CODES = new Set(['flow_state_not_found', 'flow_state_expired']);

export function classifyRecoveryExchangeError(error: unknown): RecoveryFailure {
  if (SPENT_FLOW_ERROR_CODES.has(errorCode(error))) return 'expired';
  return isVerifierMismatch(error) ? 'browser' : 'failed';
}

// A network failure or server error says nothing about the session; it must not read as "no link".
export function isTransientAuthError(error: unknown) {
  if (errorName(error) === 'AuthRetryableFetchError') return true;
  const status = errorStatus(error);
  return typeof status === 'number' && (status === 0 || status >= 500);
}

// /reset-password only works with a session that a reset link created recently. GoTrue records how
// a session was obtained in the JWT `amr` claim; a reset link adds { method: 'recovery' }.
export const RECOVERY_SESSION_MAX_AGE_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

type AmrEntry = { method?: unknown; timestamp?: unknown } | string;

// When the newest reset link behind this session was used, or null if none was.
export function recoveryTimestamp(amr: readonly AmrEntry[] | null | undefined): number | null {
  if (!Array.isArray(amr)) return null;
  let newest: number | null = null;
  for (const entry of amr) {
    if (typeof entry !== 'object' || entry === null || entry.method !== 'recovery') continue;
    const at = entry.timestamp;
    if (typeof at === 'number' && Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

export function isFreshRecoverySession(amr: readonly AmrEntry[] | null | undefined, nowSeconds: number) {
  const at = recoveryTimestamp(amr);
  if (at === null) return false;
  const age = nowSeconds - at;
  return age >= -CLOCK_SKEW_SECONDS && age <= RECOVERY_SESSION_MAX_AGE_SECONDS;
}

// Same rules and wording as changing the password while signed in (SecuritySettingsCard).
export function validateNewPassword(password: string, confirm: string): string | null {
  if (!password || !confirm) return '请完整填写新密码。';
  if (password !== confirm) return '两次输入的新密码不一致。';
  if (password.length < 8) return '新密码至少需要 8 位字符。';
  return null;
}

const SESSION_ERROR_CODES = new Set(['session_not_found', 'session_expired', 'bad_jwt', 'no_authorization']);

export type PasswordUpdateFailure = { kind: 'session' } | { kind: 'error'; message: string };

export function classifyPasswordUpdateError(error: unknown): PasswordUpdateFailure {
  const code = errorCode(error);
  if (SESSION_ERROR_CODES.has(code) || errorStatus(error) === 401) return { kind: 'session' };
  if (code === 'same_password') return { kind: 'error', message: '新密码不能和原来的密码相同。' };
  if (code === 'weak_password') return { kind: 'error', message: '新密码强度不够，请换一个更复杂的密码。' };
  if (errorStatus(error) === 429) return { kind: 'error', message: '操作太频繁，请稍后再试。' };
  return { kind: 'error', message: '密码重置失败，请稍后重试。' };
}

// Account status comes from the API's protected procedures, which reject every status but active.
// A closed and a disabled account get the same text, as on sign-in (ACCOUNT_UNAVAILABLE_MESSAGE).
export type AccountGate = 'unavailable' | 'retry';

export function classifyAccountGateError(error: unknown): AccountGate {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  // EMAIL_NOT_VERIFIED cannot follow a reset link (GoTrue confirms the email); treat it as unknown.
  if (code !== 'FORBIDDEN' || getErrorMessageText(error).includes('EMAIL_NOT_VERIFIED')) return 'retry';
  return 'unavailable';
}

export const ACCOUNT_GATE_MESSAGES: Record<AccountGate, string> = {
  unavailable: `${ACCOUNT_UNAVAILABLE_MESSAGE}，也不能重置密码。如有疑问，请联系客服。`,
  retry: '暂时无法确认账号状态，请稍后重试。',
};

export const PASSWORD_RESET_DONE_MESSAGE = '密码已重置，请用新密码登录。';
