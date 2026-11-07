/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { alertOrigin, feishuConfig, isTestSite } from './config';
import { feishuBody, feishuSign, sendFeishu } from './feishu';

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/0a1b2c3d-test-hook';
const config = { webhookUrl: HOOK, secret: 'demo' };
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const now = () => 1599360473_000;

describe('feishuSign', () => {
  it('matches the guide: HmacSHA256 keyed by "timestamp\\nsecret" over an empty message, base64', () => {
    // The guide's sample inputs (timestamp 1599360473, secret "demo"), computed with its Python sample code.
    expect(feishuSign(1599360473, 'demo')).toBe('l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
    // Same vector as Shotviva T72's test.
    expect(feishuSign(1599360473, 'demo-secret')).toBe('3/MaVZ8JLIy4TUG+7KSFJqvUkTKd+HWY8g+56DZWq8s=');
  });

  it('puts the timestamp in whole seconds, as a string, next to the sign and a text message', () => {
    expect(feishuBody('你好', 'demo', 1599360473_999)).toEqual({
      timestamp: '1599360473', sign: 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=',
      msg_type: 'text', content: { text: '你好' },
    });
  });
});

describe('sendFeishu', () => {
  it('posts JSON to the webhook and accepts code 0', async () => {
    const fetch = vi.fn(async () => answer({ StatusCode: 0, code: 0, msg: 'success', data: {} }));
    await sendFeishu(config, '你好', { fetch: fetch as never, now });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual(feishuBody('你好', 'demo', now()));
  });

  it('treats a non-zero code on HTTP 200 as a failure, and the error never names the URL or secret', async () => {
    const fetch = async () => answer({ code: 19021, msg: 'sign match fail or timestamp is not within one hour' });
    const failure = sendFeishu(config, 'x', { fetch: fetch as never, now });
    await expect(failure).rejects.toThrow('FEISHU_REFUSED_19021');
    const error = await failure.catch(e => e as Error);
    expect(String(error.message)).not.toContain('test-hook');
    expect(String(error.message)).not.toContain('demo');
  });

  it('fails on HTTP errors, odd bodies and network errors without echoing them', async () => {
    await expect(sendFeishu(config, 'x', { fetch: (async () => answer({}, 502)) as never, now }))
      .rejects.toThrow('FEISHU_HTTP_502');
    await expect(sendFeishu(config, 'x', { fetch: (async () => new Response('<html>')) as never, now }))
      .rejects.toThrow('FEISHU_UNEXPECTED_BODY');
    const down = async () => { throw new TypeError(`fetch failed ${HOOK}`); };
    const error = await sendFeishu(config, 'x', { fetch: down as never, now }).catch(e => e as Error);
    expect(error.message).toBe('FEISHU_REQUEST_FAILED');
  });
});

describe('feishuConfig', () => {
  it('is off without either variable, and says why when only one is set or the URL is not a Feishu bot', () => {
    expect(feishuConfig({})).toEqual({ config: null, problem: null });
    expect(feishuConfig({ FEISHU_ALERT_WEBHOOK_URL: '', FEISHU_ALERT_SECRET: ' ' })).toEqual({ config: null, problem: null });
    expect(feishuConfig({ FEISHU_ALERT_WEBHOOK_URL: HOOK }).problem).toBe('OWNER_ALERT_CONFIG_INCOMPLETE');
    expect(feishuConfig({ FEISHU_ALERT_SECRET: 's' }).problem).toBe('OWNER_ALERT_CONFIG_INCOMPLETE');
    expect(feishuConfig({ FEISHU_ALERT_WEBHOOK_URL: 'https://evil.example/open-apis/bot/v2/hook/abcdefgh', FEISHU_ALERT_SECRET: 's' })
      .problem).toBe('OWNER_ALERT_WEBHOOK_INVALID');
    expect(feishuConfig({ FEISHU_ALERT_WEBHOOK_URL: `${HOOK} `, FEISHU_ALERT_SECRET: ' s ' }))
      .toEqual({ config: { webhookUrl: HOOK, secret: 's' }, problem: null });
  });

  it('points links at this deployment and marks every site but production as a test site', () => {
    expect(alertOrigin({ NEXT_PUBLIC_APP_URL: 'https://staging.graylum.com/x' })).toBe('https://staging.graylum.com');
    expect(alertOrigin({})).toBe('');
    const production = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main',
      VERCEL_PROJECT_PRODUCTION_URL: 'www.graylum.com' };
    expect(alertOrigin(production)).toBe('https://www.graylum.com');
    expect(isTestSite(production)).toBe(false);
    expect(isTestSite({ ...production, VERCEL_GIT_COMMIT_REF: 'staging' })).toBe(true);
  });
});
