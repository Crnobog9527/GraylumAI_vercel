/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn(async () => ({ data: 'ok', error: null })));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc }) }));
import { POST } from './route';

// PHONE-OTP: the Send SMS hook route end to end with the fake sender. Throwaway secret; no network.
const RAW = Buffer.from('0123456789abcdef0123456789abcdef');
const ORIGINAL = { ...process.env };
function hookRequest(body: string, sign = true) {
  const id = 'msg_route', timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', RAW).update(`${id}.${timestamp}.${body}`).digest('base64');
  return new Request('https://graylum.test/api/auth/sms-hook', { method: 'POST', body, headers: {
    'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    ...(sign ? { 'webhook-signature': `v1,${signature}` } : {}),
  } });
}
const BODY = JSON.stringify({ user: { id: 'user-1', phone: '8613800005678' }, sms: { otp: '482910' } });

describe('POST /api/auth/sms-hook', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      SEND_SMS_HOOK_SECRET: `v1,whsec_${RAW.toString('base64')}`, SMS_PROVIDER: 'fake', VERCEL_ENV: 'preview',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
    });
    rpc.mockClear();
  });
  afterEach(() => { process.env = { ...ORIGINAL }; });

  it('answers 200 for a signed mainland request after sms_authorize_send, never cached', async () => {
    const response = await POST(hookRequest(BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).toHaveBeenCalledWith('sms_authorize_send', { p_phone_key: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('refuses an unsigned request, the fake sender on production, and a missing secret without touching the database', async () => {
    expect((await POST(hookRequest(BODY, false))).status).toBe(401);
    Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' });
    expect((await POST(hookRequest(BODY))).status).toBe(503);
    process.env = { ...ORIGINAL, SMS_PROVIDER: 'fake' };
    expect((await POST(hookRequest(BODY))).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });
});
