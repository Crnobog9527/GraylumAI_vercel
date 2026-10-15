/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPlatformSecretCacheForTests } from '../platformSecrets/reader';
import { loadPostForMeDeps, readPostForMeApiKey, readPostForMeWebhookSecret, requirePostForMeDeps } from './secrets';

const KEY = 'pfm_test_FAKEKEY000000000000';
const WEBHOOK = 'fake-webhook-test-00000000';
function database(value: string | null = null, error: { code: string } | null = null) {
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: value, error }) }));
  return { rpc } as unknown as Parameters<typeof readPostForMeApiKey>[0];
}
beforeEach(resetPlatformSecretCacheForTests);

describe('Post for Me unified Vault reader', () => {
  it('uses admin API and webhook values in production even with competing environment values', async () => {
    const env = { VERCEL: '1', VERCEL_ENV: 'production', POSTFORME_API_KEY: 'pfm_test_OTHER00000000',
      POSTFORME_WEBHOOK_SECRET: 'other-webhook-test-000000' };
    const api = database(KEY);
    expect(await readPostForMeApiKey(api, env)).toBe(KEY);
    expect(api.rpc).toHaveBeenCalledWith('platform_secret_read', { p_slot: 'postforme' });
    const hook = database(WEBHOOK);
    expect(await readPostForMeWebhookSecret(hook, env)).toBe(WEBHOOK);
    expect(hook.rpc).toHaveBeenCalledWith('platform_secret_read', { p_slot: 'postforme_webhook' });
  });

  it('allows fallback only on local, preview, or the exact staging project and branch', async () => {
    const empty = database();
    const env = { POSTFORME_API_KEY: KEY, POSTFORME_WEBHOOK_SECRET: WEBHOOK };
    const staging = { ...env, VERCEL: '1', VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'auth-staging.graylum.com', VERCEL_GIT_COMMIT_REF: 'staging' };
    for (const allowed of [env, { ...env, VERCEL: '1', VERCEL_ENV: 'preview' }, staging]) {
      expect(await readPostForMeApiKey(empty, allowed)).toBe(KEY);
      expect(await readPostForMeWebhookSecret(empty, allowed)).toBe(WEBHOOK);
    }
    for (const blocked of [{ ...env, VERCEL_ENV: 'production' },
      { ...staging, VERCEL_PROJECT_PRODUCTION_URL: 'app.graylum.com' },
      { ...staging, VERCEL_GIT_COMMIT_REF: 'main' }]) {
      expect(await readPostForMeApiKey(empty, blocked)).toBeNull();
      expect(await readPostForMeWebhookSecret(empty, blocked)).toBeNull();
    }
  });

  it('never falls back or reports unconfigured when Vault fails', async () => {
    const broken = database(null, { code: 'TEST_FAILURE' });
    const env = { POSTFORME_API_KEY: KEY, POSTFORME_WEBHOOK_SECRET: WEBHOOK };
    await expect(readPostForMeApiKey(broken, env)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    await expect(readPostForMeWebhookSecret(broken, env)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    await expect(loadPostForMeDeps(broken, env)).rejects.toThrow('PLATFORM_SECRET_UNAVAILABLE');
  });

  it('rejects malformed keys, and returns null only for missing configuration', async () => {
    const empty = database();
    await expect(readPostForMeApiKey(empty, { POSTFORME_API_KEY: 'invalid' })).rejects.toThrow('POSTFORME_KEY_INVALID');
    await expect(readPostForMeWebhookSecret(empty, { POSTFORME_WEBHOOK_SECRET: 'short' }))
      .rejects.toThrow('POSTFORME_KEY_INVALID');
    expect(await loadPostForMeDeps(empty, {})).toBeNull();
    expect(await readPostForMeWebhookSecret(empty, {})).toBeNull();
  });

  it('does not switch to an environment key when the stored key is malformed', async () => {
    await expect(readPostForMeApiKey(database('invalid'), { POSTFORME_API_KEY: KEY }))
      .rejects.toThrow('POSTFORME_KEY_INVALID');
  });

  it('builds connect dependencies from Vault without exposing the key through a fallback', async () => {
    expect(await requirePostForMeDeps(database(KEY))).toMatchObject({ apiKey: KEY, limiter: { acquire: expect.any(Function) } });
  });
});
