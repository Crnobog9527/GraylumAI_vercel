/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHmac } from 'node:crypto';
import type { MainlandPhone } from '../../shared/mainlandPhone';
import { webhookSecretBytes } from './webhookSignature';

/**
 * The rate-limit key in public.sms_sends: the number itself is never stored there. Keyed with the Send
 * SMS hook secret (both the send route and the hook have it), so the hex cannot be reversed by hashing
 * every mainland number. A new hook secret only resets the 24-hour counts. Null without a usable secret.
 */
export function phoneKey(phone: MainlandPhone, hookSecret: string | undefined): string | null {
  const key = hookSecret ? webhookSecretBytes(hookSecret) : null;
  if (!key) return null;
  return createHmac('sha256', key).update(`sms_sends:${phone.digits}`).digest('hex');
}
