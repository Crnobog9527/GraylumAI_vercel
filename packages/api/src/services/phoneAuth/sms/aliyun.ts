/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { swallow } from '../../../lib/swallow';
import { acsDate, signRequest } from './aliyunSign';
import type { SmsResult, SmsSender } from './types';

/**
 * SMS_PROVIDER=aliyun: Alibaba Cloud Phone Number Verification Service, "SMS verification" (Dypnsapi
 * SendSmsVerifyCode, 2017-05-25), the same service Shotviva uses (its T63). Supabase makes the code: it
 * goes in TemplateParam as `code`, with `min` for how long it works, so Aliyun only delivers it.
 * Aliyun cannot check a code it did not make, so the check stays with Supabase verifyOtp (never
 * CheckSmsVerifyCode) and the code is not asked back. SendSmsVerifyCode is the only action called: the
 * RAM user is allowed nothing else. Signature name and template come from the environment.
 * https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode
 */
export const ALIYUN_SMS_HOST = 'dypnsapi.aliyuncs.com';

export type AliyunSmsConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  /** The gifted signature name and its paired template code, from the Aliyun console. */
  signName: string;
  templateCode: string;
};

type Deps = { fetch?: typeof fetch; now?: () => Date; nonce?: () => string };

const responseSchema = z.object({ Code: z.string() });

/**
 * "Not this number, not now" rather than a broken setup: the number's daily cap, the frequency check
 * and a number Aliyun will not deliver to (with or without the isv. prefix). Anything else (permissions,
 * parameters, FUNCTION_NOT_OPENED, balance) is a setup failure, logged by its code.
 */
const REJECTED = new Set(['BUSINESS_LIMIT_CONTROL', 'FREQUENCY_FAIL', 'MOBILE_NUMBER_ILLEGAL']);
const rejected = (code: string) => REJECTED.has(code.replace(/^isv\./, ''));

/** Supabase waits at most 5 seconds for the hook: give up first so the hook still answers clearly. */
const TIMEOUT_MS = 3500;

export function aliyunSmsSender(config: AliyunSmsConfig, deps: Deps = {}): SmsSender {
  const doFetch = deps.fetch ?? fetch;
  return {
    name: 'aliyun',
    async send({ to, code, validMinutes }): Promise<SmsResult> {
      const { query, headers } = signRequest({
        host: ALIYUN_SMS_HOST,
        action: 'SendSmsVerifyCode',
        version: '2017-05-25',
        params: {
          CountryCode: '86',
          PhoneNumber: to.national,
          SignName: config.signName,
          TemplateCode: config.templateCode,
          TemplateParam: JSON.stringify({ code, min: String(validMinutes) }),
          ReturnVerifyCode: 'false',
        },
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
        date: acsDate((deps.now ?? (() => new Date()))()),
        nonce: (deps.nonce ?? randomUUID)(),
      });
      try {
        const response = await doFetch(`https://${ALIYUN_SMS_HOST}/?${query}`, {
          method: 'POST', headers, signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Refusals come back as HTTP 400 with the same JSON body, so read the body either way.
        const parsed = responseSchema.safeParse(await swallow('aliyun_sms_body_unreadable', response.json(), null, { category: 'auth' }));
        if (!parsed.success) return { ok: false, reason: 'failed', providerCode: `http_${response.status}` };
        if (parsed.data.Code === 'OK') return { ok: true };
        return { ok: false, reason: rejected(parsed.data.Code) ? 'rejected' : 'failed', providerCode: parsed.data.Code };
      } catch {
        return { ok: false, reason: 'failed', providerCode: 'network' };
      }
    },
  };
}
