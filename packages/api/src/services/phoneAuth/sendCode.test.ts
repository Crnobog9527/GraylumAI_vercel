import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => [] as unknown[]);
vi.mock('../../lib/logger', () => {
  const record = (...args: unknown[]) => { logs.push(args); };
  return { logger: { info: record, warn: record, error: record, debug: record } };
});

import { sendPhoneCode, type PhoneSendDeps } from './sendCode';
import { fakeSmsSender } from './sms/fake';

const SECRET = `v1,whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const SIGNUP = { phone: '138 0000 5678', createUser: true, privacyConsent: true, termsConsent: true };
const CONSENT_AT = '2026-11-08T01:02:03.000Z';

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

  it('records the request with the IP, then asks Supabase with the times of what the box agreed to: the terms and the privacy policy', async () => {
    const { deps, rpc, signInWithOtp } = setup();
    expect(await sendPhoneCode(SIGNUP, deps)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('sms_request_send', { p_phone_key: expect.stringMatching(/^[0-9a-f]{64}$/), p_ip: '203.0.113.7' });
    expect(signInWithOtp).toHaveBeenCalledWith({ phone: '+8613800005678', options: {
      channel: 'sms', shouldCreateUser: true,
      data: { phone_privacy_consent_at: CONSENT_AT, phone_terms_consent_at: CONSENT_AT },
    } });
  });

  // Owner 2026-11-13: the box for sending personal information abroad is gone from the form; one box, two documents.
  it('does not ask for, depend on or record the consent to send personal information abroad', async () => {
    const { deps, signInWithOtp } = setup();
    // The page as it is now never sends it.
    expect(await sendPhoneCode(SIGNUP, deps)).toEqual({ ok: true });
    // Sent as refused, it changes nothing either.
    expect(await sendPhoneCode({ ...SIGNUP, transferConsent: false }, deps)).toEqual({ ok: true });
    for (const call of signInWithOtp.mock.calls as unknown as [{ options: { data?: Record<string, unknown> } }][]) {
      expect(Object.keys(call[0].options.data ?? {}).sort()).toEqual(['phone_privacy_consent_at', 'phone_terms_consent_at']);
    }
    // A page loaded before the change ticked its two old boxes: let through, and only the privacy policy is recorded for it.
    expect(await sendPhoneCode({ phone: '13800005678', createUser: true, privacyConsent: true, transferConsent: true }, deps)).toEqual({ ok: true });
    expect(signInWithOtp).toHaveBeenLastCalledWith({ phone: '+8613800005678', options: {
      channel: 'sms', shouldCreateUser: true, data: { phone_privacy_consent_at: CONSENT_AT } } });
  });

  it('requires the box (the terms and the privacy policy) for a sign-up, and nothing for re-verifying an existing account', async () => {
    const { deps, signInWithOtp } = setup();
    expect(await sendPhoneCode({ ...SIGNUP, termsConsent: false }, deps)).toEqual({ ok: false, code: 'CONSENT_REQUIRED', status: 400 });
    expect(await sendPhoneCode({ ...SIGNUP, privacyConsent: false }, deps)).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(await sendPhoneCode({ phone: '13800005678', createUser: true }, deps)).toMatchObject({ code: 'CONSENT_REQUIRED' });
    // The old box alone, without the privacy policy, was never enough and is not now.
    expect(await sendPhoneCode({ phone: '13800005678', createUser: true, transferConsent: true }, deps)).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(await sendPhoneCode({ phone: '13800005678', createUser: false }, deps)).toEqual({ ok: true });
    expect(signInWithOtp).toHaveBeenLastCalledWith({ phone: '+8613800005678', options: { channel: 'sms', shouldCreateUser: false } });
    // A page loaded before BOT-GUARD may still send a token: accepted, never forwarded.
    expect(await sendPhoneCode({ phone: '13800005678', createUser: false, captchaToken: 'stale' }, deps)).toEqual({ ok: true });
    expect(signInWithOtp).toHaveBeenLastCalledWith({ phone: '+8613800005678', options: { channel: 'sms', shouldCreateUser: false } });
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
    const limited = setup({}, { code: 'over_request_rate_limit', status: 429 });
    expect(await sendPhoneCode(SIGNUP, limited.deps)).toEqual({ ok: false, code: 'RATE_LIMITED', status: 429 });
    expect(limited.rpc).toHaveBeenCalledWith('sms_release_send', { p_phone_key: expect.any(String) });
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
