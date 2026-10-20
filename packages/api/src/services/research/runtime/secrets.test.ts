/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ADMIN-SECRETS §10 RT acceptance for the research supplier keys (synthetic values only).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platformSecretReader } from './secrets';
import { resetPlatformSecretCacheForTests } from '../../platformSecrets/reader';

const ADMIN_KEY = 'admin-synthetic-key-0001';
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
  it.each(['tikhub', 'parallel', 'firecrawl'] as const)('%s: reads only its admin slot', async vendor => {
    const admin = store({ [vendor]: ADMIN_KEY });
    expect(await platformSecretReader(admin)(vendor)).toBe(ADMIN_KEY);
    expect(admin.rpc).toHaveBeenCalledWith('platform_secret_read', { p_slot: vendor });
  });

  it('an unfilled slot has no key and never borrows another slot', async () => {
    const reader = platformSecretReader(store({}));
    expect(await reader('parallel')).toBeNull();
    expect(await reader('tikhub')).toBeNull();
    expect(await reader('firecrawl')).toBeNull();
  });

  it('uses an admin value without any environment setup', async () => {
    const reader = platformSecretReader(store({ firecrawl: ADMIN_KEY }));
    expect(await reader('firecrawl')).toBe(ADMIN_KEY);
    expect(await reader('parallel')).toBeNull();
  });

  it('an unreadable store fails without a key in the error', async () => {
    const reader = platformSecretReader(store('down'));
    const error = await reader('tikhub').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RESEARCH_KEY_UNAVAILABLE');
    expect(JSON.stringify(error) + String(error)).not.toContain(ADMIN_KEY);
  });
});
