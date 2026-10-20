/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { sharedLimiter } from './postForMe/config';
import type { ClientDeps } from './postForMe/client';

import { getPlatformSecret, PlatformSecretError } from '../platformSecrets/reader';
import { validPlatformSecret } from '../platformSecrets/slots';
import { PostForMeNotConfigured } from './postForMe/config';

/** One reader for connect, cleanup and webhooks: the admin Vault is the only key source. */
type Admin = Parameters<typeof getPlatformSecret>[0];

export class PostForMeKeyInvalid extends Error {
  constructor() { super('POSTFORME_KEY_INVALID'); }
}

/** Only a confirmed empty slot is missing. A failed Vault read must never fall back or skip cleanup. */
async function readSecret(admin: Admin, slot: 'postforme' | 'postforme_webhook', timeoutMs?: number) {
  try {
    const secret = await getPlatformSecret(admin, slot, timeoutMs === undefined ? {} : { timeoutMs });
    if (!validPlatformSecret(slot, secret.value)) throw new PostForMeKeyInvalid();
    return secret.value;
  } catch (error) {
    if (error instanceof PlatformSecretError && error.code === 'PLATFORM_SECRET_NOT_CONFIGURED') return null;
    throw error;
  }
}

export async function readPostForMeApiKey(admin: Admin): Promise<string | null> {
  return readSecret(admin, 'postforme');
}

export async function readPostForMeWebhookSecret(admin: Admin): Promise<string | null> {
  // Leave 700 ms for the handler write within the provider's approximately one-second deadline.
  return readSecret(admin, 'postforme_webhook', 200);
}

/** Client dependencies for jobs, or null when the key is genuinely unconfigured. */
export async function loadPostForMeDeps(admin: Admin): Promise<ClientDeps | null> {
  const apiKey = await readPostForMeApiKey(admin);
  return apiKey ? { apiKey, limiter: sharedLimiter() } : null;
}

export async function requirePostForMeDeps(admin: Admin): Promise<ClientDeps> {
  const deps = await loadPostForMeDeps(admin);
  if (!deps) throw new PostForMeNotConfigured();
  return deps;
}
