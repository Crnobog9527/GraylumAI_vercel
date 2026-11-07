/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SmsLimitStatus } from './smsLimits';

/** What the send route answers; the login page maps each to one plain line (apps/web lib/phoneAuth.ts). */
export type PhoneSendCode = 'PHONE_INVALID' | 'CONSENT_REQUIRED' | 'CAPTCHA_FAILED' | 'SMS_COOLDOWN'
  | 'SMS_DAILY_LIMIT' | 'RATE_LIMITED' | 'SMS_FAILED' | 'SMS_UNAVAILABLE';

/**
 * Supabase Auth errors from signInWithOtp. `reachedHook`: the Send SMS hook ran (and recorded or refused
 * the send), so the request is not given back. Anything Supabase refuses on its own comes first.
 */
const BEFORE_HOOK: Record<string, PhoneSendCode> = {
  captcha_failed: 'CAPTCHA_FAILED',
  over_sms_send_rate_limit: 'SMS_COOLDOWN',
  over_request_rate_limit: 'RATE_LIMITED',
  validation_failed: 'PHONE_INVALID',
  phone_provider_disabled: 'SMS_UNAVAILABLE',
  sms_send_failed_no_user: 'SMS_FAILED',
  otp_disabled: 'SMS_FAILED',
  signup_disabled: 'SMS_FAILED',
  user_not_found: 'SMS_FAILED',
};

export function classifyPhoneAuthError(error: { code?: string; status?: number } | null | undefined):
  { code: PhoneSendCode; reachedHook: boolean } {
  const code = error?.code;
  if (code && Object.hasOwn(BEFORE_HOOK, code)) return { code: BEFORE_HOOK[code]!, reachedHook: false };
  if (!code && error?.status === 429) return { code: 'RATE_LIMITED', reachedHook: false };
  // sms_send_failed, hook_timeout, hook_payload_*, unexpected_failure: the hook ran or may have.
  return { code: 'SMS_FAILED', reachedHook: true };
}

/** Our own limits (sms_request_send) to the line the form shows. */
export function limitCode(status: Exclude<SmsLimitStatus, 'ok'>): PhoneSendCode {
  if (status === 'phone_cooldown') return 'SMS_COOLDOWN';
  return status === 'no_request' ? 'SMS_FAILED' : 'SMS_DAILY_LIMIT';
}
