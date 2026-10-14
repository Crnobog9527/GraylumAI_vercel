/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { postForMeApiKey, sharedLimiter } from './postForMe/config';
import type { ClientDeps } from './postForMe/client';

/**
 * Where PUBLISH-MONITOR gets its Post for Me secrets. Owner decision (ADMIN-SECRETS #975, migration 0259): third-party
 * keys are entered in the admin, not in Vercel environment variables.
 *
 * 未完成 / UNFINISHED: #975 is not merged yet. Until it is, these readers only use the server environment, and only
 * outside the real production site (staging project, previews and local testing). In production they report "not configured", so nothing depends on
 * environment variables there. After #975 merges, replace the bodies with its admin secret reader (slot 'postforme'
 * for the API key, and a webhook-secret slot to be added there) and keep the environment fallback non-production only.
 */
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
const productionLike = (env: Env) => !environmentFallbackAllowed(env);

export class PostForMeKeyInvalid extends Error {
  constructor() { super('POSTFORME_KEY_INVALID'); }
}

/** null when no key is set; a key that is set but malformed is an error, so jobs fail visibly instead of skipping. */
export async function readPostForMeApiKey(env: Env = process.env): Promise<string | null> {
  if (productionLike(env)) return null;
  if (!env.POSTFORME_API_KEY?.trim()) return null;
  try { return postForMeApiKey(env as NodeJS.ProcessEnv); } catch { throw new PostForMeKeyInvalid(); }
}

export async function readPostForMeWebhookSecret(env: Env = process.env): Promise<string | null> {
  if (productionLike(env)) return null;
  const secret = env.POSTFORME_WEBHOOK_SECRET?.trim();
  return secret && secret.length >= 16 ? secret : null;
}

/** Client dependencies for server jobs, or null when this environment has no Post for Me key. */
export async function loadPostForMeDeps(env: Env = process.env): Promise<ClientDeps | null> {
  const apiKey = await readPostForMeApiKey(env);
  return apiKey ? { apiKey, limiter: sharedLimiter(env as NodeJS.ProcessEnv) } : null;
}
