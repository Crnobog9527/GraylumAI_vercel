/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { StagingAccessError } from './stagingErrors';
/** RUNTIME-PROD: exact production domains of the production Vercel project (app today, www after the
 * PUBLIC-SITE domain merge). Exact match only, like the staging binding: a new domain needs a code change. */
const PRODUCTION_URLS: ReadonlySet<string> = new Set(['app.graylum.com', 'www.graylum.com']);
const STAGING_KEYS = ['V3_RUNTIME_STAGING_ENABLED', 'V3_RUNTIME_STAGING_PROJECT_ID',
  'V3_RUNTIME_STAGING_DATABASE_HOST', 'V3_RUNTIME_STAGING_WINDOW_ID'] as const;

/** Which real-call host this deployment is. Only the production project variable selects production;
 * everything else keeps the original staging path (which binds its own project, branch and domain). */
export function realRuntimeEnvironment(env: Record<string, string | undefined>): 'staging' | 'production' {
  return env.V3_RUNTIME_PRODUCTION_PROJECT_ID ? 'production' : 'staging';
}

/** Server environment only. Production Vercel deployment of `main` in this repository, the configured
 * project and database host, an exact domain, and no staging variable at all (no mixed configuration).
 * maintenance=true skips only the enable switch: original-call reads and receipts keep working. */
export function productionRuntimeTarget(env: Record<string, string | undefined>, maintenance = false): void {
  if (!env.V3_RUNTIME_PRODUCTION_PROJECT_ID || !env.V3_RUNTIME_PRODUCTION_DATABASE_HOST)
    throw new StagingAccessError('RUNTIME_PRODUCTION_NOT_CONFIGURED');
  if (STAGING_KEYS.some(key => env[key] !== undefined) || env.VERCEL !== '1' || env.VERCEL_ENV !== 'production'
    || !PRODUCTION_URLS.has(env.VERCEL_PROJECT_PRODUCTION_URL ?? '') || env.VERCEL_GIT_COMMIT_REF !== 'main'
    || env.VERCEL_GIT_REPO_OWNER !== 'Crnobog9527' || env.VERCEL_GIT_REPO_SLUG !== 'GraylumAI_vercel'
    || env.VERCEL_PROJECT_ID !== env.V3_RUNTIME_PRODUCTION_PROJECT_ID)
    throw new StagingAccessError('RUNTIME_PRODUCTION_TARGET_DENIED');
  let url: URL;
  try { url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? ''); }
  catch { throw new StagingAccessError('RUNTIME_PRODUCTION_TARGET_DENIED'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
    || url.hostname !== env.V3_RUNTIME_PRODUCTION_DATABASE_HOST || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash)
    throw new StagingAccessError('RUNTIME_PRODUCTION_TARGET_DENIED');
  if (!maintenance && env.V3_RUNTIME_PRODUCTION_ENABLED !== 'true') throw new StagingAccessError('RUNTIME_PRODUCTION_DISABLED');
}
