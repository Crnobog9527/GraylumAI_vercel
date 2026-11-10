import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => [] as unknown[]);
vi.mock('../../lib/logger', () => {
  const record = (...args: unknown[]) => { logs.push(args); };
  return { logger: { info: record, warn: record, error: record, debug: record } };
});

import { sendPhoneCode, type PhoneSendDeps } from './sendCode';
import { fakeSmsSender } from './sms/fake';

const SECRET = `v1,whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const SIGNUP = { phone: '138 0000 5678', createUser: true, privacyConsent: true, transferConsent: true, captchaToken: 'token' };

function setup(rpcAnswers: Record<string, unknown> = {}, authError: { code?: string; status?: number } | null = null) {
  const rpc = vi.fn(async (fn: string) => ({ data: rpcAnswers[fn] ?? (fn === 'sms_release_send' ? null : 'ok'), error: null }));
  const signInWithOtp = vi.fn(async () => ({ data: {}, error: authError }));
  const deps: PhoneSendDeps = {
    hookSecret: SECRET, sender: { sender: fakeSmsSender() }, ip: '203.0.113.7',
    admin: { rpc } as unknown as PhoneSendDeps['admin'],
    auth: { auth: { signInWithOtp } } as unknown as PhoneSendDeps['auth'],
    now: () => new Date('2026-11-08T01:02:03.000Z'),
  };
  return { deps, rpc, signInWithOtp };
}

describe('sendPhoneCode (POST /api/auth/phone/send)', () => {
  beforeEach(() => { logs.length = 0; });

  it('records the request with the IP, then asks Supabase with the captcha and both consent times', async () => {
    const { deps, rpc, signInWithOtp } = setup();
    expect(await sendPhoneCode(SIGNUP, deps)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('sms_request_send', { p_phone_key: expect.stringMatching(/^[0-9a-f]{64}$/), p_ip: '203.0.113.7' });
    expect(signInWithOtp).toHaveBeenCalledWith({ phone: '+8613800005678', options: {
      channel: 'sms', shouldCreateUser: true, captchaToken: 'token',
      data: { phone_privacy_consent_at: '2026-11-08T01:02:03.000Z', phone_transfer_consent_at: '2026-11-08T01:02:03.000Z' },
    } });
  });

  it('requires both PIPL boxes for a sign-up, and neither for re-verifying an existing account', async () => {
    const { deps, signInWithOtp } = setup();
    expect(await sendPhoneCode({ ...SIGNUP, transferConsent: false }, deps)).toEqual({ ok: false, code: 'CONSENT_REQUIRED', status: 400 });
    expect(await sendPhoneCode({ ...SIGNUP, privacyConsent: false }, deps)).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(await sendPhoneCode({ phone: '13800005678', createUser: false, captchaToken: 't' }, deps)).toEqual({ ok: true });
    expect(signInWithOtp).toHaveBeenLastCalledWith({ phone: '+8613800005678', options: { channel: 'sms', shouldCreateUser: false, captchaToken: 't' } });
  });

  it('refuses non-mainland numbers and unknown fields before touching the database', async () => {
    const { deps, rpc } = setup();
    expect(await sendPhoneCode({ ...SIGNUP, phone: '+1 415 555 0100' }, deps)).toMatchObject({ code: 'PHONE_INVALID' });
    expect(await sendPhoneCode({ ...SIGNUP, extra: 1 }, deps)).toMatchObject({ code: 'PHONE_INVALID' });
    expect(await sendPhoneCode(null, deps)).toMatchObject({ code: 'PHONE_INVALID' });
    expect(await sendPhoneCode(SIGNUP, { ...deps, hookSecret: undefined })).toMatchObject({ code: 'SMS_UNAVAILABLE', status: 503 });
    expect(await sendPhoneCode(SIGNUP, { ...deps, sender: { problem: 'x' } })).toMatchObject({ code: 'SMS_UNAVAILABLE' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers our limits without asking Supabase', async () => {
    for (const [status, code] of [['phone_cooldown', 'SMS_COOLDOWN'], ['phone_daily', 'SMS_DAILY_LIMIT'], ['ip_daily', 'SMS_DAILY_LIMIT']]) {
      const { deps, signInWithOtp } = setup({ sms_request_send: status });
      expect(await sendPhoneCode(SIGNUP, deps)).toEqual({ ok: false, code, status: 429 });
      expect(signInWithOtp).not.toHaveBeenCalled();
    }
  });

  it('gives the request back when Supabase refused before the hook, and keeps it when the hook ran', async () => {
    const captcha = setup({}, { code: 'captcha_failed', status: 400 });
    expect(await sendPhoneCode(SIGNUP, captcha.deps)).toEqual({ ok: false, code: 'CAPTCHA_FAILED', status: 400 });
    expect(captcha.rpc).toHaveBeenCalledWith('sms_release_send', { p_phone_key: expect.any(String) });
    const hook = setup({}, { code: 'sms_send_failed', status: 500 });
    expect(await sendPhoneCode(SIGNUP, hook.deps)).toEqual({ ok: false, code: 'SMS_FAILED', status: 502 });
    expect(hook.rpc).not.toHaveBeenCalledWith('sms_release_send', expect.anything());
    expect(JSON.stringify(logs)).not.toContain('13800005678');
  });

  it('drops an IP header that is not an address', async () => {
    const { deps, rpc } = setup();
    await sendPhoneCode(SIGNUP, { ...deps, ip: 'unknown, 1.2.3.4' });
    expect(rpc).toHaveBeenCalledWith('sms_request_send', expect.objectContaining({ p_ip: null }));
  });
});
