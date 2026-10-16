/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { sharedLimiter } from './postForMe/config';
import type { ClientDeps } from './postForMe/client';

import { getPlatformSecret, PlatformSecretError } from '../platformSecrets/reader';
import { validPlatformSecret } from '../platformSecrets/slots';
import { PostForMeNotConfigured } from './postForMe/config';

/** One reader for connect, cleanup and webhooks: Vault first; environment fallback only outside production. */
type Admin = Parameters<typeof getPlatformSecret>[0];
type Env = Record<string, string | undefined>;
// The separate staging project serves the staging branch from Vercel's "production" environment
// (docs/DEPLOYMENT.md), so the label alone cannot tell staging from the real production site. The fallback is
// allowed off Vercel (local tests), on preview deployments, and on exactly the staging project's domain and branch.
const STAGING_PRODUCTION_URL = 'auth-staging.graylum.com';
function environmentFallbackAllowed(env: Env): boolean {
  if (env.VERCEL !== '1') return env.VERCEL_ENV !== 'production';
  if (env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'development') return true;
  return env.VERCEL_PROJECT_PRODUCTION_URL === STAGING_PRODUCTION_URL && env.VERCEL_GIT_COMMIT_REF === 'staging';
}


export class PostForMeKeyInvalid extends Error {
  constructor() { super('POSTFORME_KEY_INVALID'); }
}

/** Only a confirmed empty slot is missing. A failed Vault read must never fall back or skip cleanup. */
async function readSecret(admin: Admin, slot: 'postforme' | 'postforme_webhook', env: Env, timeoutMs?: number) {
  try {
    const secret = await getPlatformSecret(admin, slot, { env: environmentFallbackAllowed(env) ? env : {}, timeoutMs });
    if (!validPlatformSecret(slot, secret.value)) throw new PostForMeKeyInvalid();
    return secret.value;
  } catch (error) {
    if (error instanceof PlatformSecretError && error.code === 'PLATFORM_SECRET_NOT_CONFIGURED') return null;
    throw error;
  }
}

export async function readPostForMeApiKey(admin: Admin, env: Env = process.env): Promise<string | null> {
  return readSecret(admin, 'postforme', env);
}

export async function readPostForMeWebhookSecret(admin: Admin, env: Env = process.env): Promise<string | null> {
  // Leave 700 ms for the handler write within the provider's approximately one-second deadline.
  return readSecret(admin, 'postforme_webhook', env, 200);
}

/** Client dependencies for jobs, or null when the key is genuinely unconfigured. */
export async function loadPostForMeDeps(admin: Admin, env: Env = process.env): Promise<ClientDeps | null> {
  const apiKey = await readPostForMeApiKey(admin, env);
  return apiKey ? { apiKey, limiter: sharedLimiter(env as NodeJS.ProcessEnv) } : null;
}

export async function requirePostForMeDeps(admin: Admin): Promise<ClientDeps> {
  const deps = await loadPostForMeDeps(admin);
  if (!deps) throw new PostForMeNotConfigured();
  return deps;
}
