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
});
