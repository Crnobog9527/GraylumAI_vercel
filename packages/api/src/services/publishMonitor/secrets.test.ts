/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { loadPostForMeDeps, readPostForMeApiKey, readPostForMeWebhookSecret } from './secrets';

const KEY = 'pfm_test_FAKEKEY000000000000';
describe('publish-monitor secrets (until ADMIN-SECRETS #975 merges)', () => {
  it('uses the environment only outside production', async () => {
    expect(await readPostForMeApiKey({ POSTFORME_API_KEY: KEY, VERCEL_ENV: 'preview' })).toBe(KEY);
    expect(await readPostForMeApiKey({ POSTFORME_API_KEY: KEY, VERCEL_ENV: 'production' })).toBeNull();
    // The staging project runs in Vercel's production environment: recognised by its exact domain and branch.
    const staging = { POSTFORME_API_KEY: KEY, VERCEL: '1', VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging' };
    expect(await readPostForMeApiKey(staging)).toBe(KEY);
    expect(await readPostForMeApiKey({ ...staging, VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' })).toBeNull();
    expect(await readPostForMeApiKey({ ...staging, VERCEL_GIT_COMMIT_REF: 'main' })).toBeNull();
    expect(await readPostForMeApiKey({ ...staging, VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' }))
      .toBe(KEY);
    expect(await readPostForMeWebhookSecret({ POSTFORME_WEBHOOK_SECRET: 'x'.repeat(20) })).toBe('x'.repeat(20));
    expect(await readPostForMeWebhookSecret({ POSTFORME_WEBHOOK_SECRET: 'x'.repeat(20), VERCEL_ENV: 'production' }))
      .toBeNull();
  });

  it('rejects malformed values and reports a missing key as not configured', async () => {
    expect(await readPostForMeApiKey({ POSTFORME_API_KEY: 'sk-wrong' })).toBeNull();
    expect(await readPostForMeWebhookSecret({ POSTFORME_WEBHOOK_SECRET: 'short' })).toBeNull();
    expect(await loadPostForMeDeps({})).toBeNull();
  });
});
