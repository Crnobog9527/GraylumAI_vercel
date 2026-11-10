/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { aliyunSmsSender } from './aliyun';
import { fakeSmsSender } from './fake';
import { mayUseFakeSms } from './productionGuard';
import type { SmsSender } from './types';

type Env = Record<string, string | undefined>;
export { mayUseFakeSms };
export type SenderChoice = { sender: SmsSender } | { problem: string };

const ALIYUN_KEYS = [
  'ALIYUN_SMS_ACCESS_KEY_ID', 'ALIYUN_SMS_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_TEMPLATE_CODE',
] as const;

/** The adapter SMS_PROVIDER names. `problem` is for the log: variable names only, never values. */
export function smsSenderFor(env: Env = process.env): SenderChoice {
  const provider = env.SMS_PROVIDER?.trim();
  if (!provider) return { problem: 'SMS_PROVIDER is not set' };
  if (provider === 'fake') {
    return mayUseFakeSms(env) ? { sender: fakeSmsSender() } : { problem: 'SMS_PROVIDER=fake is refused in production' };
  }
  if (provider !== 'aliyun') return { problem: 'SMS_PROVIDER must be fake or aliyun' };
  const missing = ALIYUN_KEYS.filter(key => !env[key]?.trim());
  if (missing.length) return { problem: `missing ${missing.join(', ')}` };
  return {
    sender: aliyunSmsSender({
      accessKeyId: env.ALIYUN_SMS_ACCESS_KEY_ID!.trim(),
      accessKeySecret: env.ALIYUN_SMS_ACCESS_KEY_SECRET!.trim(),
      signName: env.ALIYUN_SMS_SIGN_NAME!.trim(),
      templateCode: env.ALIYUN_SMS_TEMPLATE_CODE!.trim(),
    }),
  };
}
