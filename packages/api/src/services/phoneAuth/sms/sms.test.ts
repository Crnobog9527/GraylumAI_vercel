import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { aliyunSmsSender } from './aliyun';
import { acsDate, canonicalQuery, percentEncode } from './aliyunSign';
import { fakeSmsSender } from './fake';
import { mayUseFakeSms, smsSenderFor } from './sender';
import type { SmsMessage } from './types';

// The SMS adapters behind the Send SMS hook (PHONE-OTP). Throwaway credentials; no network.
const MESSAGE: SmsMessage = { to: { e164: '+8614000000001', national: '14000000001' }, code: '402913', validMinutes: 5 };
const CONFIG = { accessKeyId: 'test-key-id', accessKeySecret: 'test-key-secret', signName: 'TEST_SIGN', templateCode: 'TEST_TEMPLATE' };
const ALIYUN_ENV = {
  SMS_PROVIDER: 'aliyun', ALIYUN_SMS_ACCESS_KEY_ID: 'id', ALIYUN_SMS_ACCESS_KEY_SECRET: 'secret',
  ALIYUN_SMS_SIGN_NAME: 'sign', ALIYUN_SMS_TEMPLATE_CODE: 'SMS_1',
};
const PRODUCTION = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main', VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com' };

describe('smsSenderFor (SMS_PROVIDER)', () => {
  it('picks the adapter the environment names', () => {
    expect(smsSenderFor({ SMS_PROVIDER: 'fake', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'staging' }))
      .toMatchObject({ sender: { name: 'fake' } });
    expect(smsSenderFor(ALIYUN_ENV)).toMatchObject({ sender: { name: 'aliyun' } });
    expect(smsSenderFor({ ...ALIYUN_ENV, ...PRODUCTION })).toMatchObject({ sender: { name: 'aliyun' } });
  });

  it('names what is missing, never a value, and refuses the fake one on production', () => {
    expect(smsSenderFor({})).toEqual({ problem: 'SMS_PROVIDER is not set' });
    expect(smsSenderFor({ SMS_PROVIDER: 'twilio' })).toEqual({ problem: 'SMS_PROVIDER must be fake or aliyun' });
    expect(smsSenderFor({ SMS_PROVIDER: 'fake', ...PRODUCTION })).toEqual({ problem: 'SMS_PROVIDER=fake is refused in production' });
    // Production target deploying main on another domain is still refused.
    expect(mayUseFakeSms({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' })).toBe(false);
    expect(mayUseFakeSms({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/x' })).toBe(true);
    expect(smsSenderFor({ ...ALIYUN_ENV, ALIYUN_SMS_ACCESS_KEY_SECRET: undefined, ALIYUN_SMS_TEMPLATE_CODE: ' ' })).toEqual({
      problem: 'missing ALIYUN_SMS_ACCESS_KEY_SECRET, ALIYUN_SMS_TEMPLATE_CODE',
    });
  });
});

describe('fakeSmsSender', () => {
  it('sends nothing, answers ok, and keeps an outbox for tests', async () => {
    const outbox: SmsMessage[] = [];
    expect(await fakeSmsSender(outbox).send(MESSAGE)).toEqual({ ok: true });
    expect(outbox).toEqual([MESSAGE]);
  });
});

describe('Aliyun signature V3 helpers', () => {
  it('percent-encodes per RFC 3986', () => {
    expect(percentEncode("a b*c~d!'()")).toBe('a%20b%2Ac~d%21%27%28%29');
    expect(percentEncode('{"code":"1"}')).toBe('%7B%22code%22%3A%221%22%7D');
    expect(canonicalQuery({ b: '2', a: '1 1' })).toBe('a=1%201&b=2');
    expect(acsDate(new Date('2026-11-07T10:22:32.123Z'))).toBe('2026-11-07T10:22:32Z');
  });
});

describe('aliyunSmsSender (Dypnsapi SendSmsVerifyCode)', () => {
  const now = () => new Date('2026-11-07T10:22:32.000Z');
  const nonce = () => 'nonce-1';

  it('posts a signed SendSmsVerifyCode with the national number and Supabase’s code as {code, min}', async () => {
    const fetch = vi.fn(async () => Response.json({ Code: 'OK', BizId: 'b', RequestId: 'r' }));
    expect(await aliyunSmsSender(CONFIG, { fetch, now, nonce }).send(MESSAGE)).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(new URL(url).host).toBe('dypnsapi.aliyuncs.com');
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      CountryCode: '86', PhoneNumber: '14000000001', SignName: 'TEST_SIGN', TemplateCode: 'TEST_TEMPLATE',
      TemplateParam: '{"code":"402913","min":"5"}', ReturnVerifyCode: 'false',
    });
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-acs-action': 'SendSmsVerifyCode', 'x-acs-version': '2017-05-25', 'x-acs-date': '2026-11-07T10:22:32Z' });
    expect(url).not.toContain('CheckSmsVerifyCode');

    // Recompute the signature independently from the documented algorithm.
    const empty = createHash('sha256').update('').digest('hex');
    const names = ['host', 'x-acs-action', 'x-acs-content-sha256', 'x-acs-date', 'x-acs-signature-nonce', 'x-acs-version'];
    const canonical = ['POST', '/', url.split('?')[1], names.map(n => `${n}:${init.headers[n]}\n`).join(''), names.join(';'), empty].join('\n');
    const toSign = `ACS3-HMAC-SHA256\n${createHash('sha256').update(canonical).digest('hex')}`;
    const signature = createHmac('sha256', CONFIG.accessKeySecret).update(toSign).digest('hex');
    expect(init.headers.Authorization).toBe(`ACS3-HMAC-SHA256 Credential=test-key-id,SignedHeaders=${names.join(';')},Signature=${signature}`);
  });

  it('maps Aliyun refusals and failures to status words, with no code in the answer', async () => {
    const answer = (body: unknown, status = 200) =>
      aliyunSmsSender(CONFIG, { fetch: async () => Response.json(body, { status }), now, nonce }).send(MESSAGE);
    expect(await answer({ Code: 'BUSINESS_LIMIT_CONTROL', Message: 'limit' }, 400))
      .toEqual({ ok: false, reason: 'rejected', providerCode: 'BUSINESS_LIMIT_CONTROL' });
    expect(await answer({ Code: 'isv.FREQUENCY_FAIL' }, 400)).toEqual({ ok: false, reason: 'rejected', providerCode: 'isv.FREQUENCY_FAIL' });
    expect(await answer({ Code: 'FUNCTION_NOT_OPENED' }, 400)).toEqual({ ok: false, reason: 'failed', providerCode: 'FUNCTION_NOT_OPENED' });
    expect(await answer({ Code: 'isv.AMOUNT_NOT_ENOUGH' })).toEqual({ ok: false, reason: 'failed', providerCode: 'isv.AMOUNT_NOT_ENOUGH' });
    expect(await answer('nope', 500)).toEqual({ ok: false, reason: 'failed', providerCode: 'http_500' });
    const offline = await aliyunSmsSender(CONFIG, { fetch: async () => Promise.reject(new Error('offline')), now, nonce }).send(MESSAGE);
    expect(offline).toEqual({ ok: false, reason: 'failed', providerCode: 'network' });
    expect(JSON.stringify(offline)).not.toContain('402913');
  });
});
