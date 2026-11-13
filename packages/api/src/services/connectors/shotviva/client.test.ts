/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { createShotvivaClient, shotvivaOrigin, ShotvivaError } from './client';

const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
const KEY = 'sv_test_fixturekey0000';
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
const client = (send: ReturnType<typeof vi.fn>) =>
  createShotvivaClient({ baseUrl: 'https://shotviva.test', partnerKey: KEY, fetch: send as never });
const failure = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ShotvivaError);

describe('shotvivaOrigin', () => {
  it('only a bare https origin (http only for a local test server)', () => {
    expect(shotvivaOrigin('https://shotviva.com')).toBe('https://shotviva.com');
    expect(shotvivaOrigin('https://shotviva.com/')).toBe('https://shotviva.com');
    expect(shotvivaOrigin('http://127.0.0.1:4010')).toBe('http://127.0.0.1:4010');
    for (const bad of [undefined, '', 'http://shotviva.com', 'https://u:p@shotviva.com', 'https://shotviva.com/api',
      'https://shotviva.com/?x=1', 'not a url', 'javascript:alert(1)']) expect(shotvivaOrigin(bad)).toBeNull();
  });
  it('refuses to build without a valid origin or a partner key of the right kind', () => {
    expect(() => createShotvivaClient({ baseUrl: 'http://shotviva.com', partnerKey: KEY })).toThrow(ShotvivaError);
    expect(() => createShotvivaClient({ baseUrl: 'https://shotviva.com', partnerKey: 'sk-other' })).toThrow(ShotvivaError);
  });
});

describe('Shotviva partner client', () => {
  it('link: posts the code with the partner key, no redirects, and returns the parsed account', async () => {
    const send = reply(200, { account_id: ACCOUNT, display_name: 'j***@gmail.com', credits_remaining: 10, free_credits_remaining: 3 });
    expect(await client(send).link('c'.repeat(32))).toEqual(
      { account_id: ACCOUNT, display_name: 'j***@gmail.com', credits_remaining: 10, free_credits_remaining: 3 });
    const [url, init] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://shotviva.test/api/partner/link');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify({ code: 'c'.repeat(32) }) });
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(init.headers).not.toHaveProperty('X-Shotviva-Account');
  });

  it('account: names the account in the partner header', async () => {
    const send = reply(200, { credits_remaining: 5, free_credits_remaining: 0, paid_until: null,
      top_up_url: 'https://shotviva.test/pricing?from=graylum' });
    expect((await client(send).account(ACCOUNT)).top_up_url).toBe('https://shotviva.test/pricing?from=graylum');
    const [url, init] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/partner/account');
    expect(init.headers).toMatchObject({ 'X-Shotviva-Account': ACCOUNT });
  });

  it('a partner error keeps its code (and the top-up link); anything malformed is "unavailable"', async () => {
    const revoked = await failure(client(reply(401, { code: 'link_revoked', message: 'x' })).account(ACCOUNT));
    expect([revoked?.code, revoked?.status]).toEqual(['link_revoked', 401]);
    const quota = await failure(client(reply(402, { code: 'quota_exhausted', message: 'x',
      top_up_url: 'https://shotviva.test/pricing' })).account(ACCOUNT));
    expect([quota?.code, quota?.topUpUrl]).toEqual(['quota_exhausted', 'https://shotviva.test/pricing']);
    for (const send of [reply(500, 'oops'), reply(503, { code: 'not-a-code' }), reply(200, 'not json'), reply(200, { account_id: 'x' }),
      vi.fn(async () => { throw new TypeError('fetch failed'); })]) {
      expect((await failure(client(send).link('c'.repeat(32))))?.code).toBe('unavailable');
    }
  });

  it('a response over the size cap is refused, declared or streamed', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
    expect((await failure(client(reply(200, big, { 'content-length': String(big.length) })).link('c'.repeat(32))))?.code)
      .toBe('unavailable');
    expect((await failure(client(reply(200, big)).link('c'.repeat(32))))?.code).toBe('unavailable');
  });
});
