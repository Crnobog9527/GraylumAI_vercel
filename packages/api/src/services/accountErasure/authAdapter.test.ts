/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createErasureAuthAdapter } from './authAdapter';

const actor = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' },
});
function setup(body: unknown = { id: actor }, status = 200) {
  // Actual pinned SDK, synthetic responses, no network transport or credentials.
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(body, status));
  const client = createClient('https://erasure.invalid', 'synthetic-key', {
    global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { fetcher, adapter: createErasureAuthAdapter(client, actor) };
}

describe('Auth SDK adapter with injected fetch only', () => {
  it('reads the exact original identity through the pinned SDK', async () => {
    const f = setup();
    expect(await f.adapter.getState(actor)).toBe('present');
    expect(String(f.fetcher.mock.calls[0][0])).toBe(`https://erasure.invalid/auth/v1/admin/users/${actor}`);
  });
  it.each([
    [404, { code: 'user_not_found' }, 'absent'],
    [404, { code: 'unexpected_failure' }, 'unknown'],
    [404, {}, 'unknown'], [401, { code: 'user_not_found' }, 'unknown'],
    [403, { code: 'user_not_found' }, 'unknown'], [503, { code: 'user_not_found' }, 'unknown'],
    [200, { id: other }, 'unknown'], [200, {}, 'unknown'], [200, { user: null }, 'unknown'],
  ])('maps status %s and body %j conservatively', async (status, body, expected) => {
    const f = setup(body, status as number);
    expect(await f.adapter.getState(actor)).toBe(expected);
  });
  it('never sends another subject or malformed identity', async () => {
    const f = setup();
    expect(await f.adapter.getState(other)).toBe('unknown');
    await expect(f.adapter.remove(other)).rejects.toThrow('ERASURE_AUTH_UNKNOWN');
    await expect(f.adapter.remove('bad')).rejects.toThrow('ERASURE_AUTH_UNKNOWN');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(() => createErasureAuthAdapter({} as never, 'bad')).toThrow();
  });
  it('sends one hard-delete, requires later readback and refuses duplicate/concurrent calls', async () => {
    const f = setup();
    const first = f.adapter.remove(actor);
    await expect(f.adapter.remove(actor)).rejects.toThrow('ERASURE_AUTH_UNKNOWN');
    await first;
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls[0][1]?.method).toBe('DELETE');
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual({ should_soft_delete: false });
    expect(await f.adapter.getState(actor)).toBe('present');
    f.fetcher.mockImplementation(async () => response({ code: 'user_not_found' }, 404));
    expect(await f.adapter.getState(actor)).toBe('absent');
    await expect(f.adapter.remove(actor)).rejects.toThrow('ERASURE_AUTH_UNKNOWN');
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });
  it.each(['throw', 'status', 'identity'])('does not retry uncertain deletion: %s', async (mode) => {
    const f = setup();
    f.fetcher.mockImplementation(async () => {
      if (mode === 'throw') throw new Error('synthetic private detail');
      return mode === 'status' ? response({}, 503) : response({ id: other });
    });
    await expect(f.adapter.remove(actor)).rejects.toThrow(/^ERASURE_AUTH_UNKNOWN$/);
    await expect(f.adapter.remove(actor)).rejects.toThrow(/^ERASURE_AUTH_UNKNOWN$/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await f.adapter.getState(actor)).toBe('unknown');
  });
});
