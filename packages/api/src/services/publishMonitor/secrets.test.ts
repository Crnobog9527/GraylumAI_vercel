/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { loadPostForMeDeps, readPostForMeApiKey, readPostForMeWebhookSecret } from './secrets';

const KEY = 'pfm_test_FAKEKEY000000000000';
describe('publish-monitor secrets (until ADMIN-SECRETS #975 merges)', () => {
  it('uses the environment only outside production', async () => {
    expect(await readPostForMeApiKey({ POSTFORME_API_KEY: KEY, VERCEL_ENV: 'preview' })).toBe(KEY);
    expect(await readPostForMeApiKey({ POSTFORME_API_KEY: KEY, VERCEL_ENV: 'production' })).toBeNull();
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
