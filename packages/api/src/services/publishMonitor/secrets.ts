/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { postForMeApiKey, sharedLimiter } from './postForMe/config';
import type { ClientDeps } from './postForMe/client';

/**
 * Where PUBLISH-MONITOR gets its Post for Me secrets. Owner decision (ADMIN-SECRETS #975, migration 0259): third-party
 * keys are entered in the admin, not in Vercel environment variables.
 *
 * 未完成 / UNFINISHED: #975 is not merged yet. Until it is, these readers only use the server environment, and only
 * outside production (staging and local testing). In production they report "not configured", so nothing depends on
 * environment variables there. After #975 merges, replace the bodies with its admin secret reader (slot 'postforme'
 * for the API key, and a webhook-secret slot to be added there) and keep the environment fallback non-production only.
 */
type Env = Record<string, string | undefined>;
const productionLike = (env: Env) => env.VERCEL_ENV === 'production';

export async function readPostForMeApiKey(env: Env = process.env): Promise<string | null> {
  if (productionLike(env)) return null;
  try { return postForMeApiKey(env as NodeJS.ProcessEnv); } catch { return null; }
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
