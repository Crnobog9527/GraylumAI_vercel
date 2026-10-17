/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect } from 'vitest';
import { productionRuntimeTarget, realRuntimeEnvironment } from './productionEnvironment';
import { stagingRuntimeWindow } from './stagingEnvironment';

const env = {
  V3_RUNTIME_PRODUCTION_ENABLED: 'true', VERCEL: '1', VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com', VERCEL_GIT_COMMIT_REF: 'main',
  VERCEL_GIT_REPO_OWNER: 'Crnobog9527', VERCEL_GIT_REPO_SLUG: 'GraylumAI_vercel',
  V3_RUNTIME_PRODUCTION_PROJECT_ID: 'synthetic-production-project', VERCEL_PROJECT_ID: 'synthetic-production-project',
  NEXT_PUBLIC_SUPABASE_URL: 'https://prodsynthetic.supabase.co', V3_RUNTIME_PRODUCTION_DATABASE_HOST: 'prodsynthetic.supabase.co',
};

it('accepts the exact production binding', () => {
  expect(() => productionRuntimeTarget(env)).not.toThrow();
  expect(() => productionRuntimeTarget({ ...env, VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com' })).not.toThrow();
});
it.each(Object.keys(env))('fails closed with missing %s', key => expect(() => productionRuntimeTarget({ ...env, [key]: undefined })).toThrow());
it.each([
  { VERCEL_GIT_COMMIT_REF: 'staging' }, { VERCEL_ENV: 'preview' }, { VERCEL: '0' },
  { VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com' }, { VERCEL_PROJECT_PRODUCTION_URL: 'graylum.com' },
  { VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com.evil.invalid' }, { VERCEL_PROJECT_PRODUCTION_URL: 'APP.GRAYLUM.COM' },
  { VERCEL_PROJECT_PRODUCTION_URL: 'graylum-ai-vercel-v1.vercel.app' },
  { VERCEL_GIT_REPO_OWNER: 'someone-else' }, { VERCEL_GIT_REPO_SLUG: 'fork' }, { VERCEL_PROJECT_ID: 'staging-project' },
  { NEXT_PUBLIC_SUPABASE_URL: 'https://staging.supabase.co' }, { NEXT_PUBLIC_SUPABASE_URL: 'http://prodsynthetic.supabase.co' },
  { NEXT_PUBLIC_SUPABASE_URL: 'https://user:secret@prodsynthetic.supabase.co' },
  { NEXT_PUBLIC_SUPABASE_URL: 'https://prodsynthetic.supabase.co/path' },
])('rejects a mismatched target %#', patch =>
  expect(() => productionRuntimeTarget({ ...env, ...patch })).toThrow('RUNTIME_PRODUCTION_TARGET_DENIED'));

it.each(['V3_RUNTIME_STAGING_ENABLED', 'V3_RUNTIME_STAGING_PROJECT_ID', 'V3_RUNTIME_STAGING_DATABASE_HOST', 'V3_RUNTIME_STAGING_WINDOW_ID'])(
  'refuses when any staging variable %s is also set', key =>
    expect(() => productionRuntimeTarget({ ...env, [key]: 'x' }, true)).toThrow('RUNTIME_PRODUCTION_TARGET_DENIED'));

it('separates disablement from target binding', () => {
  expect(() => productionRuntimeTarget({ ...env, V3_RUNTIME_PRODUCTION_ENABLED: 'false' })).toThrow('RUNTIME_PRODUCTION_DISABLED');
  expect(() => productionRuntimeTarget({ ...env, V3_RUNTIME_PRODUCTION_ENABLED: 'false' }, true)).not.toThrow();
  expect(() => productionRuntimeTarget({ ...env, VERCEL_GIT_COMMIT_REF: 'staging' }, true)).toThrow('RUNTIME_PRODUCTION_TARGET_DENIED');
});

it('the staging binding never accepts the production deployment', () =>
  expect(() => stagingRuntimeWindow({ ...env, V3_RUNTIME_STAGING_ENABLED: 'true', V3_RUNTIME_STAGING_PROJECT_ID: env.VERCEL_PROJECT_ID,
    V3_RUNTIME_STAGING_DATABASE_HOST: 'prodsynthetic.supabase.co', V3_RUNTIME_STAGING_WINDOW_ID: '00000000-0000-4000-8000-000000000001' }))
    .toThrow('RUNTIME_STAGING_TARGET_DENIED'));

it('chooses the environment only from the production project variable', () => {
  expect(realRuntimeEnvironment(env)).toBe('production');
  expect(realRuntimeEnvironment({ V3_RUNTIME_STAGING_WINDOW_ID: 'x' })).toBe('staging');
  expect(realRuntimeEnvironment({})).toBe('staging');
});
