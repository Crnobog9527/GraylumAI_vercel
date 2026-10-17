/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readPaygHostPolicies } from './paygHostPolicy';
import { readPaygProductionPolicies } from './productionPolicy';
import { StagingAccessError } from './stagingErrors';
import type { StagingPolicy } from './stagingPolicy';

/** RUNTIME-PROD: the contract fields that tell the three hosts apart. Production carries no test window. */
export const isProductionPolicy = (policy: StagingPolicy | undefined) => policy?.mode === 'production';

export function realContract(real: StagingPolicy | undefined) {
  if (!real) return { host: { mode: 'isolated' as const }, rules: { version: 'runtime-local-v1', quoteVersion: 'runtime-local-v1' } };
  if (isProductionPolicy(real)) return { host: { mode: 'production' as const },
    rules: { version: 'runtime-production-v1', quoteVersion: real.id } };
  return { host: { mode: 'staging_test' as const, testWindowId: real.id }, rules: { version: 'runtime-staging-v1', quoteVersion: real.id } };
}

/** Rate-limit namespace of the host (redisRateLimiter already keeps production apart). */
export const runtimeGateEnvironment = (real: StagingPolicy | undefined) =>
  !real ? 'local' as const : isProductionPolicy(real) ? 'production' as const : 'staging' as const;

/** New admissions read the PAYG profiles of their own host: the window's setting or the production setting. */
export const readPaygPolicies = (real: StagingPolicy) => isProductionPolicy(real) ? readPaygProductionPolicies : readPaygHostPolicies;

/** Features whose production path is not built yet (Fusion review, see docs/launch/tasks/RUNTIME-PROD.md section 6)
 * refuse a production policy before anything is priced or frozen, instead of failing later on a window field. */
export function refuseOnProduction(policy: StagingPolicy) {
  if (isProductionPolicy(policy)) throw new StagingAccessError('RUNTIME_PRODUCTION_FEATURE_UNAVAILABLE');
}
