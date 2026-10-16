/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { environmentSecretReader, isProductionDeployment } from './secrets';

const keys = { TIKHUB_API_KEY: ' test-tikhub ', PARALLEL_API_KEY: 'test-parallel', FIRECRAWL_API_KEY: 'test-firecrawl' };

describe('research environment secret placeholder', () => {
  it.each(['tikhub', 'parallel', 'firecrawl'] as const)('reads only the %s slot outside production', async vendor => {
    expect(await environmentSecretReader({ ...keys, VERCEL_ENV: 'preview' })(vendor)).toBe(`test-${vendor}`);
  });

  it.each([
    { VERCEL_ENV: 'production' },
    { VERCEL_TARGET_ENV: 'production' },
    { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'production' },
    { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' },
  ])('blocks all environment keys when production is indicated by %j', async deployment => {
    const env = { ...keys, ...deployment };
    expect(isProductionDeployment(env)).toBe(true);
    for (const vendor of ['tikhub', 'parallel', 'firecrawl'] as const) {
      expect(await environmentSecretReader(env)(vendor)).toBeNull();
    }
  });

  it('returns null for missing or blank keys without falling back to another vendor', async () => {
    const reader = environmentSecretReader({ TIKHUB_API_KEY: '  \n ', PARALLEL_API_KEY: 'test-parallel' });
    expect(await reader('tikhub')).toBeNull();
    expect(await reader('firecrawl')).toBeNull();
    expect(isProductionDeployment({})).toBe(false);
  });
});
