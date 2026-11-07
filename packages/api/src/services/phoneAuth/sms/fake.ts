/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SmsMessage, SmsResult, SmsSender } from './types';

/**
 * SMS_PROVIDER=fake: sends nothing and answers ok, for tests, local runs, staging and previews
 * (sender.ts refuses it on the production site). Tests pass `outbox` to see what would have gone out.
 */
export function fakeSmsSender(outbox?: SmsMessage[]): SmsSender {
  return {
    name: 'fake',
    async send(message): Promise<SmsResult> {
      outbox?.push(message);
      return { ok: true };
    },
  };
}
