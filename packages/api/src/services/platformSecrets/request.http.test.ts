/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createClient } from '@supabase/supabase-js';
import { readOpenRouterKey } from '../models/openRouterKey';
import { withPlatformSecretRequest } from './request';
import { resetPlatformSecretCacheForTests } from './reader';

const OLD = 'synthetic-http-old-canary';
const NEXT = 'synthetic-http-next-canary';
afterEach(() => { vi.restoreAllMocks(); resetPlatformSecretCacheForTests(); });

it('real HTTP/JSONL stream shares the fresh read through mentor and organizer; next HTTP request sees replacement/clear', async () => {
  let value: string | null = OLD;
  let expected = OLD;
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  const db = createClient('https://synthetic.invalid', 'synthetic-anon', {
    global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const t = initTRPC.create();
  const app = t.router({ turn: t.procedure.mutation(async function* () {
    const a = await readOpenRouterKey(db, { fresh: true });
    if (!a || a !== expected) throw new Error('EXPECTED_CREDENTIAL_REQUIRED');
    yield { stage: 'mentor' };
    await new Promise(resolve => setTimeout(resolve, 0));
    value = 'synthetic-changed-during-current-request';
    const b = await readOpenRouterKey(db, { fresh: true });
    if (a !== b) throw new Error('REQUEST_CREDENTIAL_CHANGED');
    yield { stage: 'organizer' };
  }) });
  const run = async () => {
    const req = new Request('http://localhost/api/trpc/turn?batch=1', {
      method: 'POST', headers: { 'content-type': 'application/json', 'trpc-accept': 'application/jsonl' },
      body: JSON.stringify({ '0': null }),
    });
    const response = await withPlatformSecretRequest(() => fetchRequestHandler({
      req, router: app, endpoint: '/api/trpc', createContext: () => ({}),
    }));
    expect(response.status).toBe(200);
    return response.text(); // includes generator work after the Response has already returned
  };
  const first = await run();
  expect(first).toContain('mentor'); expect(first).toContain('organizer');
  expect(first).not.toContain(OLD);
  expect(transport).toHaveBeenCalledTimes(1);
  value = NEXT; expected = NEXT;
  const second = await run();
  expect(second).toContain('organizer'); expect(second).not.toContain(NEXT);
  expect(transport).toHaveBeenCalledTimes(2);
  value = null;
  expect(await run()).toContain('EXPECTED_CREDENTIAL_REQUIRED');
  expect(transport).toHaveBeenCalledTimes(3);
});

it('real Supabase/PostgREST timeout shape retries once and shares recovery across consumers', async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if (transport.mock.calls.length === 1) return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
    return new Response(JSON.stringify(NEXT), { headers: { 'content-type': 'application/json' } });
  });
  const db = createClient('https://synthetic.invalid', 'synthetic-anon', {
    global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { getPlatformSecret } = await import('./reader');
  const result = await withPlatformSecretRequest(() => Promise.all([
    getPlatformSecret(db, 'openrouter', { fresh: true, timeoutMs: 20 }),
    getPlatformSecret(db, 'openrouter', { fresh: true, timeoutMs: 20 }),
  ]));
  expect(result).toEqual(Array(2).fill({ value: NEXT, source: 'admin' }));
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.map(call => new URL(String(call[0])).pathname))
    .toEqual(['/rest/v1/rpc/platform_secret_read', '/rest/v1/rpc/platform_secret_read']);
});

it('real PostgREST permission denial is terminal and never uses a stale key', async () => {
  const { getPlatformSecret } = await import('./reader');
  let deny = false;
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(deny
    ? { code: '42501', message: OLD, details: NEXT } : OLD), {
    status: deny ? 403 : 200, headers: { 'content-type': 'application/json' },
  }));
  const db = createClient('https://synthetic.invalid', 'synthetic-anon', {
    global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await getPlatformSecret(db, 'openrouter');
  deny = true;
  await expect(withPlatformSecretRequest(() => readOpenRouterKey(db, { fresh: true })))
    .rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
  expect(transport).toHaveBeenCalledTimes(2); // seed + one refused request, no transport retry
});
