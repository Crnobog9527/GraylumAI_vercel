/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PhoneSendCode } from '@repo/api/src/services/phoneAuth/phoneErrors';

/**
 * PHONE-OTP (Owner 2026-11-07): mainland phone sign-in on the Simplified Chinese login page only. The Taiwan pages
 * link to /login?lang=zh-Hant and an English entry would carry lang=en; those keep email only.
 */
export function phoneSignInAllowed(lang: string | null | undefined): boolean {
  return lang !== 'zh-Hant' && lang !== 'en';
}

export const PHONE_SEND_PATH = '/api/auth/phone/send';

export const PHONE_SEND_MESSAGES: Record<PhoneSendCode, string> = {
  PHONE_INVALID: '目前只支持中国大陆（+86）手机号，请检查号码。',
  CONSENT_REQUIRED: '请先勾选同意隐私政策和个人信息出境，才能获取验证码。',
  CAPTCHA_FAILED: '人机验证未通过，请重试。',
  SMS_COOLDOWN: '验证码刚发过，请 60 秒后再获取。',
  SMS_DAILY_LIMIT: '这个号码今天获取验证码的次数已用完，请明天再试，或改用邮箱。',
  RATE_LIMITED: '操作太频繁，请稍后再试。',
  SMS_FAILED: '短信没有发出去，请稍后再试，或改用邮箱。',
  SMS_UNAVAILABLE: '手机号登录暂时不可用，请改用邮箱。',
};

export const PHONE_CODE_INVALID_MESSAGE = '验证码不对或已过期，请检查后重输，或重新获取。';
export const PHONE_VERIFY_FAILED_MESSAGE = '登录没有完成，请稍后重试。';

export type PhoneSendRequest = {
  phone: string;
  createUser: boolean;
  privacyConsent?: boolean;
  transferConsent?: boolean;
  captchaToken?: string;
};

/** Asks the server for a code; resolves to null when sent, or the line to show. */
export async function requestPhoneCode(body: PhoneSendRequest, doFetch: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await doFetch(PHONE_SEND_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin',
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; code?: string } | null;
    if (response.ok && data?.ok) return null;
    const code = data?.code;
    return code && Object.hasOwn(PHONE_SEND_MESSAGES, code) ? PHONE_SEND_MESSAGES[code as PhoneSendCode] : PHONE_SEND_MESSAGES.SMS_FAILED;
  } catch {
    return PHONE_SEND_MESSAGES.SMS_FAILED;
  }
}

/** verifyOtp errors: a wrong or expired code says so; anything else is a plain failure. */
export function phoneVerifyErrorMessage(error: { code?: string; status?: number } | null | undefined): string {
  const code = error?.code ?? '';
  if (['otp_expired', 'invalid_credentials', 'phone_not_confirmed', 'validation_failed'].includes(code)) return PHONE_CODE_INVALID_MESSAGE;
  if (!code && (error?.status === 400 || error?.status === 403)) return PHONE_CODE_INVALID_MESSAGE;
  return PHONE_VERIFY_FAILED_MESSAGE;
}
