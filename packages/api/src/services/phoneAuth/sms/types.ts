/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * The SMS side of phone sign-in (PHONE-OTP). Supabase makes the code and checks it; the Send SMS hook
 * hands it to one of these adapters. Which one is SMS_PROVIDER's call (sender.ts), so nothing else
 * names a provider. An adapter never logs, stores or reports the code; only its status words leave it.
 */
export type SmsRecipient = {
  /** '+8613800005678' */
  e164: string;
  /** '13800005678', the form mainland providers take. */
  national: string;
};

/** `validMinutes`: how long the code works, for templates that say so. */
export type SmsMessage = { to: SmsRecipient; code: string; validMinutes: number };

/**
 * rejected: the provider refused this one (its own frequency cap, a number it will not serve); failed:
 * anything else (network, credentials, balance). `providerCode` is the provider's status word for the
 * log, never its message text.
 */
export type SmsResult = { ok: true } | { ok: false; reason: 'rejected' | 'failed'; providerCode?: string };

export interface SmsSender {
  readonly name: 'fake' | 'aliyun';
  send(message: SmsMessage): Promise<SmsResult>;
}
