/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { clearTestOpenRouterKey, seedTestOpenRouterKey } from '../models/openRouterKey.testing';
import { getPlatformSecret } from './reader';
import { withPlatformSecretRequest } from './request';
import { logger } from '../../lib/logger';

const url = process.env.V3_LOCAL_DB!;
if (!url?.startsWith('postgres://postgres@127.0.0.1:') || !url.endsWith('/v3_disposable'))
  throw new Error('isolated database runner required');
const db = new pg.Client({ connectionString: url });
beforeAll(() => db.connect());
afterAll(() => db.end());
const OLD = 'SYNTHETIC_SCOPE_OLD_CANARY';
const NEXT = 'SYNTHETIC_SCOPE_NEXT_CANARY';
const enabled = process.env.V3_LOCAL_STAGING_SCHEMA === 'true';
function client(transport: typeof fetch, anonymous = false) {
  return createClient(process.env.V3_LOCAL_REST!, anonymous
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! : process.env.V3_LOCAL_SERVICE_JWT!, {
    global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
const read = (admin: ReturnType<typeof client>) => getPlatformSecret(admin, 'openrouter', { fresh: true });

it.runIf(enabled)('RUNTIME: scoped fresh Vault timeout retries once; same request reuses and next request sees replace/clear', async () => {
  await seedTestOpenRouterKey(db, OLD);
  const base = globalThis.fetch;
  let calls = 0;
  const admin = client(async (input, init) => {
    calls++;
    if (calls === 1) return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
    return base(input, init);
  });
  const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    await withPlatformSecretRequest(async () => {
      const result = await Promise.all([read(admin), read(admin), read(admin)]);
      expect(result).toEqual(Array(3).fill({ value: OLD, source: 'admin' }));
      await seedTestOpenRouterKey(db, NEXT);
      expect((await read(admin)).value).toBe(OLD);
      expect(calls).toBe(2); // timed out transport + actual local PostgREST/Vault RPC
    });
    expect((await withPlatformSecretRequest(() => read(admin))).value).toBe(NEXT);
    expect(calls).toBe(3);
    await clearTestOpenRouterKey(db);
    await expect(withPlatformSecretRequest(() => read(admin))).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
    expect(calls).toBe(4);
    expect(log).toHaveBeenCalledWith('security', 'platform_secret_read_failed', expect.objectContaining({
      errorType: 'timeout', retrying: true, elapsedMs: expect.any(Number),
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(OLD);
    expect(JSON.stringify(log.mock.calls)).not.toContain(NEXT);
  } finally { log.mockRestore(); }
}, 30000);

it.runIf(enabled)('RUNTIME: scoped fresh Vault twice-failed network read refuses every consumer and next request recovers', async () => {
  await seedTestOpenRouterKey(db, NEXT);
  const base = globalThis.fetch;
  let fail = true, calls = 0;
  const admin = client(async (input, init) => {
    calls++;
    if (fail) throw new TypeError('fetch failed');
    return base(input, init);
  });
  await withPlatformSecretRequest(async () => {
    const outcomes = await Promise.allSettled([read(admin), read(admin)]);
    expect(outcomes.map(x => x.status)).toEqual(['rejected', 'rejected']);
    expect(calls).toBe(2);
    fail = false;
    await expect(read(admin)).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    expect(calls).toBe(2);
  });
  expect((await withPlatformSecretRequest(() => read(admin))).value).toBe(NEXT);
  expect(calls).toBe(3);
}, 30000);

it.runIf(enabled)('RUNTIME: scoped fresh Vault actual anonymous permission denial never retries', async () => {
  const base = globalThis.fetch;
  let calls = 0;
  const anonymous = client(async (input, init) => { calls++; return base(input, init); }, true);
  await expect(withPlatformSecretRequest(() => read(anonymous))).rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
  expect(calls).toBe(1);
}, 30000);
