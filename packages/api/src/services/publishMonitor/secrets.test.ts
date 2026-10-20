/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPlatformSecretCacheForTests } from '../platformSecrets/reader';
import { createPost } from './postForMe/posts';
import { loadPostForMeDeps, readPostForMeApiKey, readPostForMeWebhookSecret, requirePostForMeDeps } from './secrets';
import { handlePostForMeWebhook, WEBHOOK_SECRET_HEADER } from './webhook';

const KEY = 'pfm_test_FAKEKEY000000000000';
const WEBHOOK = 'fake-webhook-test-00000000';
function database(value: string | null = null, error: { code: string } | null = null) {
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: value, error }) }));
  return { rpc } as unknown as Parameters<typeof readPostForMeApiKey>[0];
}
beforeEach(resetPlatformSecretCacheForTests);
afterEach(() => vi.unstubAllEnvs());

function removeLegacyCredentialEnvironment() {
  for (const name of ['POSTFORME_API_KEY', 'POSTFORME_WEBHOOK_SECRET', 'TIKHUB_API_KEY', 'PARALLEL_API_KEY', 'FIRECRAWL_API_KEY']) {
    vi.stubEnv(name, undefined);
  }
}

describe('Post for Me Vault reader', () => {
  it('reads API and webhook credentials from their separate admin slots', async () => {
    const api = database(KEY);
    expect(await readPostForMeApiKey(api)).toBe(KEY);
    expect(api.rpc).toHaveBeenCalledWith('platform_secret_read', { p_slot: 'postforme' });
    const hook = database(WEBHOOK);
    expect(await readPostForMeWebhookSecret(hook)).toBe(WEBHOOK);
    expect(hook.rpc).toHaveBeenCalledWith('platform_secret_read', { p_slot: 'postforme_webhook' });
  });

  it('reports an empty slot as missing and Vault errors as unavailable', async () => {
    const empty = database();
    expect(await loadPostForMeDeps(empty)).toBeNull();
    expect(await readPostForMeWebhookSecret(empty)).toBeNull();
    resetPlatformSecretCacheForTests();
    const broken = database(null, { code: 'TEST_FAILURE' });
    await expect(readPostForMeApiKey(broken)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    await expect(readPostForMeWebhookSecret(broken)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    await expect(loadPostForMeDeps(broken)).rejects.toThrow('PLATFORM_SECRET_UNAVAILABLE');
  });

  it('rejects malformed values stored in the Vault', async () => {
    await expect(readPostForMeApiKey(database('invalid'))).rejects.toThrow('POSTFORME_KEY_INVALID');
    await expect(readPostForMeWebhookSecret(database('short'))).rejects.toThrow('POSTFORME_KEY_INVALID');
  });

  it('publishes with the Vault API key after the legacy provider variables are deleted', async () => {
    removeLegacyCredentialEnvironment();
    const deps = await requirePostForMeDeps(database(KEY));
    const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
      expect(input).toBe('https://api.postforme.dev/v1/social-posts');
      expect(init.method).toBe('POST');
      return new Response(JSON.stringify({ id: 'sp_1' }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    const outcome = await createPost({ ...deps, limiter: { acquire: async () => ({ ok: true as const }) }, fetchImpl }, {
      externalId: '11111111-1111-4111-8111-111111111111', caption: 'synthetic publish',
      socialAccountIds: ['spc_1'], mediaUrls: [],
    });
    expect(outcome).toEqual({ kind: 'created', providerPostId: 'sp_1' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1].headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  it('accepts a webhook using the Vault shared secret after the legacy provider variables are deleted', async () => {
    removeLegacyCredentialEnvironment();
    const secret = await readPostForMeWebhookSecret(database(WEBHOOK));
    const writes = vi.fn(() => ({ abortSignal: async () => ({ data: true, error: null }) }));
    const request = new Request('https://synthetic.test/api/postforme/webhook', {
      method: 'POST',
      body: JSON.stringify({ event_type: 'social.account.updated', data: { id: 'spc_1', status: 'disconnected' } }),
      headers: { [WEBHOOK_SECRET_HEADER]: WEBHOOK },
    });
    const result = await handlePostForMeWebhook(request, secret ?? undefined, () => ({ rpc: writes }) as never);
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(writes).toHaveBeenCalledWith('publish_monitor_provider_account_disconnected', { p_provider_account_id: 'spc_1' });
  });
});
