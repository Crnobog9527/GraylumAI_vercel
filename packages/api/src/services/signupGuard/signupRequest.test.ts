/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => [] as unknown[]);
vi.mock('../../lib/logger', () => {
  const record = (...args: unknown[]) => { logs.push(args); };
  return { logger: { info: record, warn: record, error: record, debug: record } };
});

import { requestSignup, signupEmailKey, signupRequestResponse } from './signupRequest';

const rpcAnswering = (data: unknown, error: { code?: string } | null = null) => vi.fn(async () => ({ data, error }));
const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }) =>
  new Request('https://auth-staging.graylum.com/api/auth/signup/request', { method: 'POST', headers, body: JSON.stringify(body) });

beforeEach(() => { logs.length = 0; });

describe('signupEmailKey', () => {
  it('is the sha256 of the trimmed, lower-cased address, the same key the Before User Created hook recomputes', () => {
    const expected = createHash('sha256').update('name@example.com').digest('hex');
    expect(signupEmailKey('  Name@Example.COM ')).toBe(expected);
    expect(signupEmailKey('name@example.com')).toBe(expected);
  });
});

describe('requestSignup (POST /api/auth/signup/request)', () => {
  it('records the hashed address and the IP, and accepts', async () => {
    const rpc = rpcAnswering('ok');
    expect(await requestSignup({ email: ' Name@Example.com ' }, { admin: { rpc } as never, ip: '203.0.113.7' })).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('signup_request', { p_email_key: signupEmailKey('name@example.com'), p_ip: '203.0.113.7' });
    expect(JSON.stringify(logs)).not.toContain('example.com');
  });

  it('refuses over the per-IP limits with distinct codes (429)', async () => {
    expect(await requestSignup({ email: 'a@example.com' }, { admin: { rpc: rpcAnswering('ip_hourly') } as never, ip: '203.0.113.7' }))
      .toEqual({ ok: false, code: 'SIGNUP_TOO_MANY_HOURLY', status: 429 });
    expect(await requestSignup({ email: 'a@example.com' }, { admin: { rpc: rpcAnswering('ip_daily') } as never, ip: '203.0.113.7' }))
      .toEqual({ ok: false, code: 'SIGNUP_TOO_MANY_DAILY', status: 429 });
  });

  it('refuses a malformed address before touching the database', async () => {
    const rpc = rpcAnswering('ok');
    for (const body of [{ email: 'not-an-email' }, { email: 'a@example.com', extra: 1 }, null, 'a@example.com']) {
      expect(await requestSignup(body, { admin: { rpc } as never, ip: null })).toEqual({ ok: false, code: 'EMAIL_INVALID', status: 400 });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes no IP when the header is not an address, and fails closed when the database errs or answers oddly', async () => {
    const rpc = rpcAnswering('ok');
    await requestSignup({ email: 'a@example.com' }, { admin: { rpc } as never, ip: 'spoofed' });
    expect(rpc).toHaveBeenCalledWith('signup_request', expect.objectContaining({ p_ip: null }));
    for (const admin of [{ rpc: rpcAnswering(null, { code: '42501' }) }, { rpc: rpcAnswering('surprise') }]) {
      expect(await requestSignup({ email: 'a@example.com' }, { admin: admin as never, ip: null }))
        .toEqual({ ok: false, code: 'SIGNUP_UNAVAILABLE', status: 503 });
    }
  });
});

describe('signupRequestResponse', () => {
  it('answers JSON with the first forwarded address as the IP', async () => {
    const rpc = rpcAnswering('ok');
    const response = await signupRequestResponse(post({ email: 'a@example.com' }), () => ({ rpc }) as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('signup_request', expect.objectContaining({ p_ip: '203.0.113.7' }));
  });

  it('refuses a non-JSON post (415), a limited IP (429) and an unconfigured server (503)', async () => {
    const rpc = rpcAnswering('ok');
    expect((await signupRequestResponse(post({ email: 'a@example.com' }, { 'content-type': 'text/plain' }), () => ({ rpc }) as never)).status).toBe(415);
    expect(rpc).not.toHaveBeenCalled();
    const limited = await signupRequestResponse(post({ email: 'a@example.com' }), () => ({ rpc: rpcAnswering('ip_hourly') }) as never);
    expect([limited.status, await limited.json()]).toEqual([429, { ok: false, code: 'SIGNUP_TOO_MANY_HOURLY' }]);
    const broken = await signupRequestResponse(post({ email: 'a@example.com' }), () => { throw new Error('no service role'); });
    expect([broken.status, await broken.json()]).toEqual([503, { ok: false, code: 'SIGNUP_UNAVAILABLE' }]);
  });
});
