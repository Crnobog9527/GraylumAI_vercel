/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SignupRequestCode } from '@repo/api/src/services/signupGuard/signupRequest';

/**
 * BOT-GUARD (Owner 2026-11-13): an email sign-up is registered with our server (hashed address + IP) right before
 * supabase.auth.signUp; Supabase's Before User Created hook refuses email sign-ups without that record.
 */
export const SIGNUP_REQUEST_PATH = '/api/auth/signup/request';

export const SIGNUP_REQUEST_MESSAGES: Record<SignupRequestCode, string> = {
  EMAIL_INVALID: '邮箱格式不对，请检查后重试。',
  // The hourly limit really does take up to an hour to clear; say so (Shotviva first wrote "one minute").
  SIGNUP_TOO_MANY_HOURLY: '这个网络一小时内注册次数太多，请一小时后再试，或用 Google 登录。',
  SIGNUP_TOO_MANY_DAILY: '这个网络今天注册次数太多，请明天再试，或用 Google 登录。',
  SIGNUP_UNAVAILABLE: '注册暂时不可用，请稍后重试。',
};

/** Resolves to null when registered, or the line to show (never throws). */
export async function registerSignup(email: string, doFetch: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await doFetch(SIGNUP_REQUEST_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }), credentials: 'same-origin',
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; code?: string } | null;
    if (response.ok && data?.ok) return null;
    const code = data?.code;
    if (code && Object.hasOwn(SIGNUP_REQUEST_MESSAGES, code)) return SIGNUP_REQUEST_MESSAGES[code as SignupRequestCode];
    // A firewall rate limit answers 429 without our body.
    return response.status === 429 ? SIGNUP_REQUEST_MESSAGES.SIGNUP_TOO_MANY_HOURLY : SIGNUP_REQUEST_MESSAGES.SIGNUP_UNAVAILABLE;
  } catch {
    return SIGNUP_REQUEST_MESSAGES.SIGNUP_UNAVAILABLE;
  }
}

/**
 * The email sign-up order the hook relies on: register first, and only call Supabase when that succeeded.
 * Resolves to the line to show when registration refused, otherwise whatever signUp resolved to.
 */
export async function signUpAfterRegistration<T>(email: string, signUp: (email: string) => Promise<T>,
  register: (email: string) => Promise<string | null> = registerSignup): Promise<{ refused: string } | { result: T }> {
  const address = email.trim();
  const refused = await register(address);
  if (refused) return { refused };
  return { result: await signUp(address) };
}
