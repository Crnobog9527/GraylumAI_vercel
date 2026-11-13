/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { requestPhoneCode } from '@/lib/phoneAuth';

/**
 * PHONE-OTP: a phone account re-verifies before account erasure with an SMS code to the number of its own session
 * (never a number typed in). The server then requires that sign-in to be recent (accountErasure/reauth.ts), as for
 * a password or an email code. Each step resolves to null on success or the line to show.
 */
type PhoneAuthClient = {
  auth: {
    getUser(): Promise<{ data: { user: { phone?: string | null } | null } }>;
    verifyOtp(params: { phone: string; token: string; type: 'sms' }): Promise<{ error: unknown }>;
  };
};

export async function sessionPhoneE164(client: PhoneAuthClient): Promise<string | null> {
  const { data } = await client.auth.getUser();
  const digits = data.user?.phone?.replace(/^\+/, '');
  return digits ? `+${digits}` : null;
}

export async function sendPhoneReauthCode(client: PhoneAuthClient,
  send: typeof requestPhoneCode = requestPhoneCode): Promise<string | null> {
  const phone = await sessionPhoneE164(client);
  if (!phone) return '当前会话缺少手机号信息，无法发送验证码。';
  return send({ phone, createUser: false });
}

export async function verifyPhoneReauth(client: PhoneAuthClient, code: string): Promise<string | null> {
  const phone = await sessionPhoneE164(client);
  if (!phone || !/^\d{6}$/.test(code.trim())) return '请输入 6 位验证码。';
  const { error } = await client.auth.verifyOtp({ phone, token: code.trim(), type: 'sms' });
  return error ? '验证码无效或已过期。' : null;
}
