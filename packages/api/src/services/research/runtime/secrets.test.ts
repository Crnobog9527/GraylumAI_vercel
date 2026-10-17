/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ADMIN-SECRETS §10 RT acceptance for the research supplier keys (synthetic values only).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isProductionDeployment, platformSecretReader } from './secrets';
import { resetPlatformSecretCacheForTests } from '../../platformSecrets/reader';

const ADMIN_KEY = 'admin-synthetic-key-0001';
const env = { TIKHUB_API_KEY: ' env-synthetic-tikhub ', PARALLEL_API_KEY: 'env-synthetic-parallel', FIRECRAWL_API_KEY: 'env-synthetic-firecrawl' };
function store(values: Record<string, string | null> | 'down') {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    if (name !== 'platform_secret_read') throw new Error(name);
    return Promise.resolve(values === 'down' ? { data: null, error: { code: 'PGRST000', message: 'down' } }
      : { data: values[String(args.p_slot)] ?? null, error: null });
  });
  return { rpc };
}
beforeEach(() => resetPlatformSecretCacheForTests());

describe('research supplier keys through the admin secret store', () => {
  it.each(['tikhub', 'parallel', 'firecrawl'] as const)('%s: the admin value wins over the environment', async vendor => {
    const admin = store({ [vendor]: ADMIN_KEY });
    expect(await platformSecretReader(admin, env)(vendor)).toBe(ADMIN_KEY);
    expect(admin.rpc).toHaveBeenCalledWith('platform_secret_read', { p_slot: vendor });
  });

  it('an unfilled slot uses its own environment variable during the transition, never another vendor\'s', async () => {
    const reader = platformSecretReader(store({}), { PARALLEL_API_KEY: 'env-synthetic-parallel' });
    expect(await reader('parallel')).toBe('env-synthetic-parallel');
    expect(await reader('tikhub')).toBeNull();
    expect(await reader('firecrawl')).toBeNull();
  });

  it('with the environment variables removed (transition over) only the admin value is used', async () => {
    const reader = platformSecretReader(store({ firecrawl: ADMIN_KEY }), {});
    expect(await reader('firecrawl')).toBe(ADMIN_KEY);
    expect(await reader('parallel')).toBeNull();
  });

  it('an unreadable store fails without falling back to the environment and without the key in the error', async () => {
    const reader = platformSecretReader(store('down'), env);
    const error = await reader('tikhub').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RESEARCH_KEY_UNAVAILABLE');
    expect(JSON.stringify(error) + String(error)).not.toContain('env-synthetic');
  });

  it.each([
    { VERCEL_ENV: 'production' }, { VERCEL_TARGET_ENV: 'production' }, { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'production' },
  ])('production (%j) never uses the environment fallback, but does use the admin value', async deployment => {
    expect(isProductionDeployment({ ...env, ...deployment })).toBe(true);
    expect(await platformSecretReader(store({}), { ...env, ...deployment })('tikhub')).toBeNull();
    resetPlatformSecretCacheForTests();
    expect(await platformSecretReader(store({ tikhub: ADMIN_KEY }), { ...env, ...deployment })('tikhub')).toBe(ADMIN_KEY);
  });
});
