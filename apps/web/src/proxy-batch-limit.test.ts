/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TRPC_MAX_BATCH_CALLS, trpcCallCount } from '@/lib/trpcBatchLimit';

const checkRateLimit = vi.fn(async () => ({ success: true, limit: 60, remaining: 59, reset: 0 }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const { proxy } = await import('./proxy');
const batch = (n: number, method = 'GET') => new NextRequest(
  `https://auth-staging.graylum.com/api/trpc/${Array.from({ length: n }, (_, i) => `library.list${i}`).join(',')}?batch=1`,
  { method, headers: { 'x-forwarded-for': '203.0.113.9' } });

beforeEach(() => checkRateLimit.mockClear());

describe('tRPC batch size (ARCH-FIX A1)', () => {
  it('counts calls only for batch requests', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(trpcCallCount('/api/trpc/a,b,c', q('batch=1'))).toBe(3);
    expect(trpcCallCount('/api/trpc/a', q('batch=1'))).toBe(1);
    expect(trpcCallCount('/api/trpc/a,b', q(''))).toBe(1);
    expect(trpcCallCount('/api/upload', q('batch=1'))).toBe(0);
  });

  it('counts encoded separators the way tRPC decodes them', async () => {
    const q = new URLSearchParams('batch=1');
    expect(trpcCallCount('/api/trpc/a%2Cb%2cc', q)).toBe(3);
    expect(trpcCallCount('/api/trpc/a%E0%A4%A', q)).toBe(Infinity);
    const encoded = Array.from({ length: TRPC_MAX_BATCH_CALLS + 1 }, () => 'settings.getSystemSettings').join('%2C');
    const response = await proxy(new NextRequest(`https://auth-staging.graylum.com/api/trpc/${encoded}?batch=1`));
    expect(response.status).toBe(400);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'])('%s: a full batch passes on to the IP limit', async method => {
    const response = await proxy(batch(TRPC_MAX_BATCH_CALLS, method));
    expect(response.status).not.toBe(400);
    expect(checkRateLimit).toHaveBeenCalledWith('203.0.113.9', 'ip');
  });

  it.each(['GET', 'POST'])('%s: one call more is refused before any limiter or database work', async method => {
    const response = await proxy(batch(TRPC_MAX_BATCH_CALLS + 1, method));
    expect(response.status).toBe(400);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('puts ticket attachment uploads under the per-IP limit', async () => {
    checkRateLimit.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0, reset: 0, retryAfter: 30 } as never);
    const response = await proxy(new NextRequest('https://auth-staging.graylum.com/api/upload',
      { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } }));
    expect(response.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith('203.0.113.9', 'ip');
  });

  it('gives requests carrying a login the wider per-IP guard; others keep 60 a minute', async () => {
    const url = 'https://auth-staging.graylum.com/api/trpc/library.list?batch=1';
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    await proxy(new NextRequest(url, { headers: ip }));
    await proxy(new NextRequest(url, { headers: { ...ip, authorization: 'Bearer token' } }));
    await proxy(new NextRequest(url, { headers: { ...ip, cookie: 'sb-abc-auth-token.0=chunk' } }));
    await proxy(new NextRequest(url, { headers: { ...ip, authorization: 'Bearer ', cookie: 'sb-abc-other=1' } }));
    expect(checkRateLimit.mock.calls.map(c => (c as unknown[])[1])).toEqual(['ip', 'ip_session', 'ip_session', 'ip']);
  });
});
