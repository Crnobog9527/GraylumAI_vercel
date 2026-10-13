/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  createAuthUrl, deleteAccount, getAccount, listAccountsByExternalId, readFeedPage, type ClientDeps,
} from './client';
import { postForMeApiKey } from './config';
import { privateHost, publicHttpsUrl } from './http';
import { flattenMetrics, xSnowflakeTime } from './normalize';

const KEY = 'pfm_live_TESTKEY0000000000000000';
const EXTERNAL = 'a'.repeat(16) + '.' + 'b'.repeat(16);
type Call = { url: string; init: RequestInit };

function deps(responses: Array<Response | Error>, allow = true): { deps: ClientDeps; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, deps: {
    apiKey: KEY,
    limiter: { acquire: async () => (allow ? { ok: true } : { ok: false, retryAfterSeconds: 7 }) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next || next instanceof Error) throw next ?? new Error('no response');
      return next;
    },
  } };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const snowflake = (ms: number) => String((BigInt(ms) - 1288834974657n) << 22n);

describe('post for me client', () => {
  it('passes the shared limiter before any request and sends the key only as a bearer header', async () => {
    const blocked = deps([], false);
    expect(await getAccount(blocked.deps, 'spc_1')).toEqual({ kind: 'rate_limited', retryAfterSeconds: 7 });
    expect(blocked.calls).toEqual([]);
    const ok = deps([json(200, { id: 'spc_1', platform: 'x', status: 'connected', external_id: EXTERNAL, username: 'u' })]);
    const result = await getAccount(ok.deps, 'spc_1');
    expect(result).toEqual({ kind: 'ok', value: { id: 'spc_1', platform: 'x', status: 'connected', externalId: EXTERNAL,
      username: 'u' } });
    expect(ok.calls[0]!.url).toBe('https://api.postforme.dev/v1/social-accounts/spc_1');
    expect(ok.calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${KEY}` } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('classifies provider answers without guessing', async () => {
    const run = async (r: Response | Error) => getAccount(deps([r]).deps, 'spc_1');
    expect(await run(json(429, {}, { 'retry-after': '37' }))).toEqual({ kind: 'rate_limited', retryAfterSeconds: 37 });
    expect(await run(json(401, { error: {} }))).toEqual({ kind: 'rejected', status: 401 });
    expect(await run(json(500, { statusCode: 500 }))).toMatchObject({ kind: 'failed', status: 500 });
    expect(await run(json(200, { id: 'spc_1' }))).toMatchObject({ kind: 'failed', reason: 'RESPONSE_SHAPE' });
    expect(await run(new Response('<html>', { status: 200 }))).toMatchObject({ kind: 'failed', reason: 'RESPONSE_NOT_JSON' });
    expect(await run(new Error('socket'))).toEqual({ kind: 'unknown', reason: 'NETWORK_ERROR' });
    expect(await run(json(408, {}))).toEqual({ kind: 'unknown', reason: 'PROVIDER_TIMEOUT' });
    const huge = new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 });
    expect(await run(huge)).toMatchObject({ kind: 'failed', reason: 'RESPONSE_TOO_LARGE' });
  });

  it('refuses malformed identifiers before calling', async () => {
    const d = deps([]);
    expect(() => getAccount(d.deps, '../x')).toThrow('POSTFORME_ACCOUNT_ID_INVALID');
    expect(() => deleteAccount(d.deps, 'a/b')).toThrow('POSTFORME_ACCOUNT_ID_INVALID');
    expect(() => listAccountsByExternalId(d.deps, 'user-123')).toThrow('POSTFORME_EXTERNAL_ID_INVALID');
    expect(d.calls).toEqual([]);
  });

  it('builds read-only consent links and accepts only public https links back', async () => {
    const d = deps([json(201, { url: 'https://accounts.google.com/o/oauth2?x=1' })]);
    const result = await createAuthUrl(d.deps, { platform: 'youtube', externalId: EXTERNAL, permissions: ['feeds'] });
    expect(result).toEqual({ kind: 'ok', value: 'https://accounts.google.com/o/oauth2?x=1' });
    expect(JSON.parse(String(d.calls[0]!.init.body))).toEqual({ platform: 'youtube', external_id: EXTERNAL, permissions: ['feeds'] });
    const linkedin = deps([json(201, { url: 'https://www.linkedin.com/oauth' })]);
    await createAuthUrl(linkedin.deps, { platform: 'linkedin', externalId: EXTERNAL, permissions: ['feeds'] });
    expect(JSON.parse(String(linkedin.calls[0]!.init.body)).platform_data).toEqual({ linkedin: { connection_type: 'organization' } });
    expect(() => createAuthUrl(deps([]).deps, { platform: 'instagram', externalId: EXTERNAL, permissions: ['feeds'] }))
      .toThrow('POSTFORME_INSTAGRAM_CONNECTION_TYPE_REQUIRED');
    expect(() => createAuthUrl(deps([]).deps, { platform: 'bluesky', externalId: EXTERNAL, permissions: ['feeds'] }))
      .toThrow('POSTFORME_BLUESKY_NEEDS_APP_PASSWORD');
    expect(() => createAuthUrl(deps([]).deps, { platform: 'x', externalId: EXTERNAL, permissions: ['posts'] }))
      .toThrow('POSTFORME_PERMISSIONS_INVALID');
    for (const url of ['http://x.com/a', 'https://127.0.0.1/a', 'https://user:pw@x.com/', 'javascript:alert(1)']) {
      const bad = await createAuthUrl(deps([json(201, { url })]).deps, { platform: 'x', externalId: EXTERNAL, permissions: ['feeds'] });
      expect(bad).toMatchObject({ kind: 'failed', reason: 'RESPONSE_SHAPE' });
    }
  });

  it('normalizes feed pages: missing is listed not zeroed, X time from the post ID, unsafe links dropped', async () => {
    const at = Date.UTC(2026, 8, 4, 12, 0, 0);
    const page = { data: [
      { platform_post_id: snowflake(at), platform_url: 'https://x.com/u/status/1', caption: 'hello\nworld',
        metrics: { public_metrics: { like_count: 0, impression_count: 12 }, non_public_metrics: { url_link_clicks: null } } },
      { platform_post_id: 'v1', posted_at: '2026-09-14T09:28:23Z', platform_url: 'http://10.0.0.1/x', metrics: { views: 'n/a' } },
      { caption: 'no id' },
    ], meta: { cursor: 'c2', has_more: true } };
    const d = deps([json(200, page)]);
    const result = await readFeedPage(d.deps, 'spc_1', 'x', { limit: 500, platformPostIds: ['v1'] });
    expect(d.calls[0]!.url).toContain('expand=metrics&limit=100&platform_post_id=v1');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value).toMatchObject({ rejected: 1, nextCursor: 'c2', hasMore: true });
    const [x, other] = result.value.posts;
    expect(x).toMatchObject({ postedAt: new Date(at).toISOString(), postedAtSource: 'x_snowflake', titleExcerpt: 'hello world',
      metrics: { 'public_metrics.like_count': 0, 'public_metrics.impression_count': 12 },
      missingFields: ['non_public_metrics.url_link_clicks'] });
    expect(other).toMatchObject({ postedAt: '2026-09-14T09:28:23.000Z', postedAtSource: 'provider', url: null,
      metrics: {}, missingFields: ['views'] });
    const bad = await readFeedPage(deps([json(200, { posts: [] })]).deps, 'spc_1', 'x');
    expect(bad).toMatchObject({ kind: 'failed', reason: 'RESPONSE_SHAPE' });
    // Measured: an unknown account answers 500, which must stay "not fetched", not "no posts".
    expect(await readFeedPage(deps([json(500, {})]).deps, 'spc_1', 'x')).toMatchObject({ kind: 'failed', status: 500 });
  });

  it('helpers reject private hosts, bad keys and impossible snowflakes', () => {
    for (const host of ['localhost', '10.1.2.3', '192.168.0.1', '169.254.1.1', '[::1]', 'intranet', 'a.internal', '100.64.0.1']) {
      expect(privateHost(host)).toBe(true);
    }
    expect(privateHost('www.youtube.com')).toBe(false);
    expect(publicHttpsUrl('https://www.youtube.com/watch?v=1')).toBe('https://www.youtube.com/watch?v=1');
    expect(publicHttpsUrl('https://' + 'a'.repeat(3000) + '.com')).toBeNull();
    expect(() => postForMeApiKey({})).toThrow('POSTFORME_NOT_CONFIGURED');
    expect(() => postForMeApiKey({ POSTFORME_API_KEY: 'sk-other' })).toThrow('POSTFORME_NOT_CONFIGURED');
    expect(postForMeApiKey({ POSTFORME_API_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(xSnowflakeTime('123')).toBeNull();
    expect(flattenMetrics({ a: { b: { c: { d: { e: 1 } } } } }).metrics).toEqual({});
  });
});
