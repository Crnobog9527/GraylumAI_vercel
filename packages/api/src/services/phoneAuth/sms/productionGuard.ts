/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isProductionSite } from '../../../shared/productionSite';

type Env = Record<string, string | undefined>;

/**
 * PHONE-OTP: anything that could be the production site refuses the fake SMS sender: the strict production check, or a
 * deployment of `main` on Vercel's production target (a rebound domain must still not wait for codes that never come).
 * Staging deploys `staging`, previews their own branches.
 */
export function mayUseFakeSms(env: Env): boolean {
  if (isProductionSite(env)) return false;
  return !(env.VERCEL_ENV === 'production' && env.VERCEL_GIT_COMMIT_REF === 'main');
}
