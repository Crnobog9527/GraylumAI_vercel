/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ limit: vi.fn(), send: vi.fn() }));
vi.mock('@repo/api/src/services/phoneAuth', () => ({ phoneSendResponse: mocks.send }));
vi.mock('@/lib/rateLimit', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), checkRateLimit: mocks.limit,
}));

const { POST } = await import('./route');
const request = (ip: string) => new Request('https://auth-staging.graylum.com/api/auth/phone/send', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ phone: '13800005678', createUser: false, captchaToken: 'invalid' }),
});

// A sliding window like the real one: `max` attempts per IP, every attempt counted.
function windowOf(max: number) {
  const used = new Map<string, number>();
  return async (ip: string) => {
    const n = (used.get(ip) ?? 0) + 1;
    used.set(ip, n);
    return n <= max
      ? { success: true, limit: max, remaining: max - n, reset: 0 }
      : { success: false, limit: max, remaining: 0, reset: 0, retryAfter: 120, reason: 'rate_limited' };
  };
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/auth/phone/send attempt limit (deep review 11-11 item 7)', () => {
  it('lets an attempt within the IP limit through to the per-number limits', async () => {
    mocks.limit.mockImplementation(windowOf(10));
    mocks.send.mockResolvedValue(Response.json({ ok: true }));
    const response = await POST(request('203.0.113.9'));
    expect(response.status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith('203.0.113.9', 'phone_send');
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('counts failed hCaptcha attempts, so a loop from one IP stops before the database while the owner still gets in', async () => {
    mocks.limit.mockImplementation(windowOf(10));
    mocks.send.mockImplementation(async () => Response.json({ ok: false, code: 'CAPTCHA_FAILED' }, { status: 400 }));
    for (let i = 0; i < 10; i += 1) expect((await POST(request('198.51.100.7'))).status).toBe(400);

    const refused = await POST(request('198.51.100.7'));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ ok: false, code: 'RATE_LIMITED' });
    expect(refused.headers.get('Retry-After')).toBe('120');
    expect(mocks.send).toHaveBeenCalledTimes(10);

    mocks.send.mockResolvedValueOnce(Response.json({ ok: true }));
    expect((await POST(request('203.0.113.9'))).status).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(11);
  });

  it('refuses when the limiter cannot be reached, without asking Supabase', async () => {
    mocks.limit.mockResolvedValue({ success: false, limit: 0, remaining: 0, reset: 0, retryAfter: 60, reason: 'unavailable' });
    const response = await POST(request('203.0.113.9'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: 'SMS_UNAVAILABLE' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
