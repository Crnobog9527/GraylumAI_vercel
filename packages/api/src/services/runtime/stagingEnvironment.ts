/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
/** Server environment only. No request headers, browser flags or fallback.
 * The separate staging project uses Vercel's production deployment class;
 * project domain and source branch, rather than that class, identify it.
 */
export function stagingRuntimeWindow(env:Record<string,string|undefined>,maintenance=false):string {
 if((!maintenance&&env.V3_RUNTIME_STAGING_ENABLED!=='true') || env.VERCEL!=='1' ||
  env.VERCEL_PROJECT_PRODUCTION_URL!=='graylumai-staging.vercel.app' ||
  env.VERCEL_GIT_COMMIT_REF!=='staging' ||
  env.VERCEL_GIT_REPO_OWNER!=='Crnobog9527' || env.VERCEL_GIT_REPO_SLUG!=='GraylumAI_vercel' ||
  !env.V3_RUNTIME_STAGING_PROJECT_ID || env.VERCEL_PROJECT_ID!==env.V3_RUNTIME_STAGING_PROJECT_ID)
  throw new Error('RUNTIME_STAGING_DISABLED');
 const url=new URL(env.NEXT_PUBLIC_SUPABASE_URL??'http://invalid.local');
 if(url.protocol!=='https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) ||
  url.hostname!==env.V3_RUNTIME_STAGING_DATABASE_HOST || url.username || url.password || url.port || url.pathname!=='/' || url.search || url.hash)
  throw new Error('RUNTIME_STAGING_TARGET_DENIED');
 return z.string().uuid().parse(env.V3_RUNTIME_STAGING_WINDOW_ID);
}
