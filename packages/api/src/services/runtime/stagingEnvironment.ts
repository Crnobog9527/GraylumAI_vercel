/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { StagingAccessError } from './stagingErrors';
/** Server environment only. The separate staging project uses Vercel's
 * production class; project, source branch and database bind the target. */
export function stagingRuntimeWindow(env: Record<string, string | undefined>, maintenance = false): string {
  if (!env.V3_RUNTIME_STAGING_PROJECT_ID || !env.V3_RUNTIME_STAGING_DATABASE_HOST || !env.V3_RUNTIME_STAGING_WINDOW_ID)
    throw new StagingAccessError('RUNTIME_STAGING_NOT_CONFIGURED');
  if (env.VERCEL !== '1' || env.VERCEL_PROJECT_PRODUCTION_URL !== 'graylumai-staging.vercel.app' ||
      env.VERCEL_GIT_COMMIT_REF !== 'staging' || env.VERCEL_GIT_REPO_OWNER !== 'Crnobog9527' ||
      env.VERCEL_GIT_REPO_SLUG !== 'GraylumAI_vercel' || env.VERCEL_PROJECT_ID !== env.V3_RUNTIME_STAGING_PROJECT_ID)
    throw new StagingAccessError('RUNTIME_STAGING_TARGET_DENIED');
  let url: URL;
  try { url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? ''); }
  catch { throw new StagingAccessError('RUNTIME_STAGING_NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) ||
      url.hostname !== env.V3_RUNTIME_STAGING_DATABASE_HOST || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash)
    throw new StagingAccessError('RUNTIME_STAGING_TARGET_DENIED');
  const window = z.string().uuid().safeParse(env.V3_RUNTIME_STAGING_WINDOW_ID);
  if (!window.success) throw new StagingAccessError('RUNTIME_STAGING_NOT_CONFIGURED');
  if (!maintenance && env.V3_RUNTIME_STAGING_ENABLED !== 'true') throw new StagingAccessError('RUNTIME_STAGING_DISABLED');
  return window.data;
}
