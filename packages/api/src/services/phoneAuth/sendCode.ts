/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isIP } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { swallow } from '../../lib/swallow';
import { maskPhone, parseMainlandPhone } from '../../shared/mainlandPhone';
import { classifyPhoneAuthError, limitCode, type PhoneSendCode } from './phoneErrors';
import { phoneKey } from './phoneKey';
import { releaseSmsSend, requestSmsSend } from './smsLimits';
import type { SenderChoice } from './sms/sender';

/**
 * POST /api/auth/phone/send (PHONE-OTP). The login page runs in the browser, so this is the one server
 * step: our limits first (they also note the visitor's IP, which the Send SMS hook payload does not carry),
 * then Supabase, which calls the hook. A refusal before the hook gives the request
 * back, so failed checks cannot use up a stranger's five codes a day. The code itself is checked in the
 * browser with verifyOtp, like email sign-in.
 */
export const phoneSendInput = z.object({
  phone: z.string().max(32),
  /**
   * Sign-up and sign-in share one form: a new number becomes an account, so the form's one box is required. The box is
   * "我已阅读并同意《服务条款》和《隐私政策》" (Owner 2026-11-13) and the page sends it as these two.
   */
  createUser: z.boolean().default(true),
  privacyConsent: z.boolean().default(false),
  termsConsent: z.boolean().default(false),
  /**
   * The separate box for sending personal information out of mainland China, which the form no longer has (Owner 2026-11-13:
   * "同意的这个选项和显示给删了，不要展示"). Nothing depends on it. A page loaded before the change still sends it, with the
   * privacy box and without the terms: that page is let through on its two boxes.
   */
  transferConsent: z.boolean().optional(),
  /** BOT-GUARD: no captcha any more; a page loaded before the change may still send one, which is ignored. */
  captchaToken: z.string().max(8192).optional(),
}).strict();

export type PhoneSendResult = { ok: true } | { ok: false; code: PhoneSendCode; status: number };

export type PhoneSendDeps = {
  hookSecret: string | undefined;
  sender: SenderChoice;
  /** Service role: the sms_* functions. */
  admin: Pick<SupabaseClient, 'rpc'>;
  /** Anon key, no session: signInWithOtp only. */
  auth: Pick<SupabaseClient, 'auth'>;
  ip: string | null;
  now?: () => Date;
};

const fail = (code: PhoneSendCode, status: number): PhoneSendResult => ({ ok: false, code, status });

export async function sendPhoneCode(raw: unknown, deps: PhoneSendDeps): Promise<PhoneSendResult> {
  const parsed = phoneSendInput.safeParse(raw);
  if (!parsed.success) return fail('PHONE_INVALID', 400);
  const input = parsed.data;
  const phone = parseMainlandPhone(input.phone);
  if (!phone) return fail('PHONE_INVALID', 400);
  if (input.createUser && !(input.privacyConsent && (input.termsConsent || input.transferConsent))) return fail('CONSENT_REQUIRED', 400);
  const key = phoneKey(phone, deps.hookSecret);
  if (!key || 'problem' in deps.sender) {
    logger.error('auth', 'phone_send_unconfigured', { problem: 'problem' in deps.sender ? deps.sender.problem : 'hook secret' });
    return fail('SMS_UNAVAILABLE', 503);
  }
  const ip = deps.ip && isIP(deps.ip) ? deps.ip : null;
  const status = await requestSmsSend(deps.admin, key, ip);
  if (status !== 'ok') return fail(limitCode(status), 429);

  const consentAt = (deps.now ?? (() => new Date()))().toISOString();
  const { error } = await deps.auth.auth.signInWithOtp({
    phone: phone.e164,
    options: {
      channel: 'sms',
      shouldCreateUser: input.createUser,
      // Applied only when this creates the account: what its box agreed to, as separate records. phone_transfer_consent_at
      // is no longer written; the accounts that have one keep it.
      ...(input.createUser ? { data: { phone_privacy_consent_at: consentAt,
        ...(input.termsConsent ? { phone_terms_consent_at: consentAt } : {}) } } : {}),
    },
  });
  if (!error) return { ok: true };
  const outcome = classifyPhoneAuthError(error);
  if (!outcome.reachedHook) {
    await swallow('phone_send_release_failed', releaseSmsSend(deps.admin, key), undefined,
      { category: 'auth', phone: maskPhone(phone.digits) });
  }
  logger.warn('auth', 'phone_send_refused', {
    phone: maskPhone(phone.digits), code: error.code ?? null, status: error.status ?? null, result: outcome.code,
  });
  return fail(outcome.code, outcome.code === 'SMS_FAILED' ? 502 : 429);
}
