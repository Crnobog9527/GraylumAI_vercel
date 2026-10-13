/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  createAuthUrl, deleteAccount, getAccount, listAccountsByExternalId, listAllAccounts, readFeedPage, type ClientDeps,
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
    expect(await run(new Response('', { status: 408 }))).toEqual({ kind: 'unknown', reason: 'PROVIDER_TIMEOUT' });
    expect(await run(new Response('<html>', { status: 408 }))).toEqual({ kind: 'unknown', reason: 'PROVIDER_TIMEOUT' });
    const huge = new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 });
    expect(await run(huge)).toMatchObject({ kind: 'failed', reason: 'RESPONSE_TOO_LARGE' });
  });

  it('never reports a write as failed when it may have taken effect', async () => {
    for (const r of [json(502, {}), new Response('', { status: 503 }), new Response('<html>', { status: 200 })]) {
      expect((await deleteAccount(deps([r]).deps, 'spc_1')).kind).toBe('unknown');
    }
    expect(await deleteAccount(deps([json(404, {})]).deps, 'spc_1')).toEqual({ kind: 'rejected', status: 404 });
    expect(await deleteAccount(deps([json(200, { success: true })]).deps, 'spc_1')).toEqual({ kind: 'ok', value: true });
  });

  it('pages through every matching account', async () => {
    const acct = (id: string) => ({ id, platform: 'facebook', status: 'connected', external_id: EXTERNAL });
    const first = deps([json(200, { data: Array.from({ length: 100 }, (_, i) => acct(`spc_${i}`)),
      meta: { total: 130, offset: 0, limit: 100 } })]);
    const p1 = await listAccountsByExternalId(first.deps, EXTERNAL);
    expect(first.calls[0]!.url).toContain(`limit=100&offset=0&external_id=${encodeURIComponent(EXTERNAL)}`);
    expect(p1.kind === 'ok' && p1.value.nextOffset).toBe(100);
    const second = deps([json(200, { data: Array.from({ length: 30 }, (_, i) => acct(`spc_x${i}`)),
      meta: { total: 130, offset: 100, limit: 100 } })]);
    const p2 = await listAccountsByExternalId(second.deps, EXTERNAL, 100);
    expect(p2.kind === 'ok' && [p2.value.accounts.length, p2.value.nextOffset]).toEqual([30, null]);
    // A page that does not answer the offset asked for is not trusted.
    expect(await listAllAccounts(deps([json(200, { data: [], meta: { total: 5, offset: 0, limit: 100 } })]).deps, 100))
      .toMatchObject({ kind: 'failed', reason: 'RESPONSE_SHAPE' });
    expect(await listAllAccounts(deps([json(200, { data: [] })]).deps)).toMatchObject({ kind: 'failed' });
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
    expect(result).toEqual({ kind: 'ok', value: { url: 'https://accounts.google.com/o/oauth2?x=1', combinedAuthorization: false } });
    const sent = JSON.parse(String(d.calls[0]!.init.body));
    expect(sent).toMatchObject({ platform: 'youtube', external_id: EXTERNAL, permissions: ['feeds'] });
    expect(sent.platform_data.youtube.permission_overrides).toContain('https://www.googleapis.com/auth/youtube.readonly');
    expect(sent.platform_data.youtube.permission_overrides.join(' ')).not.toMatch(/upload|force-ssl/);
    const x = deps([json(201, { url: 'https://x.com/i/oauth2' })]);
    expect(await createAuthUrl(x.deps, { platform: 'x', externalId: EXTERNAL, permissions: ['feeds'] }))
      .toMatchObject({ kind: 'ok', value: { combinedAuthorization: true } });
    expect(JSON.parse(String(x.calls[0]!.init.body)).platform_data).toBeUndefined();
    const fb = deps([json(201, { url: 'https://www.facebook.com/dialog' })]);
    await createAuthUrl(fb.deps, { platform: 'facebook', externalId: EXTERNAL, permissions: ['feeds'] });
    expect(JSON.parse(String(fb.calls[0]!.init.body)).platform_data.facebook.permission_overrides).not.toContain('pages_manage_posts');
    const linkedin = deps([json(201, { url: 'https://www.linkedin.com/oauth' })]);
    await createAuthUrl(linkedin.deps, { platform: 'linkedin', externalId: EXTERNAL, permissions: ['feeds'] });
    expect(JSON.parse(String(linkedin.calls[0]!.init.body)).platform_data.linkedin)
      .toMatchObject({ connection_type: 'organization', permission_overrides: ['r_basicprofile', 'r_organization_social', 'rw_organization_admin'] });
    expect(() => createAuthUrl(deps([]).deps, { platform: 'instagram', externalId: EXTERNAL, permissions: ['feeds'] }))
      .toThrow('POSTFORME_INSTAGRAM_CONNECTION_TYPE_REQUIRED');
    expect(() => createAuthUrl(deps([]).deps, { platform: 'bluesky', externalId: EXTERNAL, permissions: ['feeds'] }))
      .toThrow('POSTFORME_BLUESKY_CREDENTIALS_INVALID');
    expect(() => createAuthUrl(deps([]).deps, { platform: 'bluesky', externalId: EXTERNAL, permissions: ['feeds'],
      bluesky: { handle: 'me.bsky.social', appPassword: 'my-main-password' } })).toThrow('POSTFORME_BLUESKY_CREDENTIALS_INVALID');
    const sky = deps([json(201, { url: 'https://bsky.app/ok' })]);
    await createAuthUrl(sky.deps, { platform: 'bluesky', externalId: EXTERNAL, permissions: ['feeds'],
      bluesky: { handle: ' Me.bsky.social ', appPassword: 'abcd-efgh-ijkl-mnop' } });
    expect(JSON.parse(String(sky.calls[0]!.init.body)).platform_data)
      .toEqual({ bluesky: { handle: 'me.bsky.social', app_password: 'abcd-efgh-ijkl-mnop' } });
    expect(() => createAuthUrl(deps([]).deps, { platform: 'x', externalId: EXTERNAL, permissions: ['posts'] }))
      .toThrow('POSTFORME_PERMISSIONS_INVALID');
    expect(() => createAuthUrl(deps([]).deps, { platform: 'x', externalId: EXTERNAL, permissions: ['feeds', 'posts'] }))
      .toThrow('POSTFORME_PUBLISH_NEEDS_REAUTH');
    const publish = deps([json(201, { url: 'https://x.com/i/oauth2' })]);
    await createAuthUrl(publish.deps, { platform: 'x', externalId: EXTERNAL, permissions: ['posts', 'feeds'], forceReauth: true });
    const publishBody = JSON.parse(String(publish.calls[0]!.init.body));
    expect(publishBody).toMatchObject({ permissions: ['feeds', 'posts'], force_reauth: true });
    expect(publishBody.platform_data).toBeUndefined();
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
    const sky = deps([json(200, { data: [], meta: {} })]);
    await readFeedPage(sky.deps, 'spc_2', 'bluesky', { platformPostIds: ['at://did:plc:abc/app.bsky.feed.post/3k'] });
    expect(sky.calls[0]!.url).toContain('platform_post_id=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fapp.bsky.feed.post%2F3k');
    expect(() => readFeedPage(deps([]).deps, 'spc_2', 'x', { platformPostIds: ['a b'] })).toThrow('POSTFORME_POST_ID_INVALID');
    expect(() => readFeedPage(deps([]).deps, 'spc_2', 'x', { platformPostIds: ['a'.repeat(257)] })).toThrow('POSTFORME_POST_ID_INVALID');
    const mixed = await readFeedPage(deps([json(200, { data: [{ platform_post_id: 'a'.repeat(257) },
      { platform_post_id: 'ok1' }], meta: {} })]).deps, 'spc_2', 'bluesky');
    expect(mixed.kind === 'ok' && [mixed.value.rejected, mixed.value.posts[0]!.missingFields]).toEqual([1, ['metrics']]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value).toMatchObject({ rejected: 1, nextCursor: 'c2', hasMore: true });
    const [x, other] = result.value.posts;
    expect(x).toMatchObject({ postedAt: new Date(at).toISOString(), postedAtSource: 'x_snowflake', titleExcerpt: 'hello world',
      metrics: { 'public_metrics.like_count': 0, 'public_metrics.impression_count': 12 },
      missingFields: ['non_public_metrics.url_link_clicks'] });
    expect(other).toMatchObject({ postedAt: '2026-09-14T09:28:23.000Z', postedAtSource: 'provider', url: null,
      metrics: {}, missingFields: ['views'] });
    const yt = await readFeedPage(deps([json(200, { data: [{ platform_post_id: 'v9', caption: 'long description',
      platform_data: { title: 'Video title' } }], meta: {} })]).deps, 'spc_3', 'youtube');
    expect(yt.kind === 'ok' && yt.value.posts[0]!.titleExcerpt).toBe('Video title');
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
    const deep = flattenMetrics({ a: { b: { c: { d: { e: 1 } } } } });
    expect(deep.metrics).toEqual({});
    expect(deep.missingFields).toEqual(['a.b.c.d']);
    const arrays = flattenMetrics({ audience_countries: [{ country: 'US', percentage: 0.4 }], retention: [100, 80.5],
      bad: [{ nested: { x: 1 } }], huge: Array.from({ length: 101 }, () => 1) });
    expect(arrays.breakdowns).toEqual({ audience_countries: [{ country: 'US', percentage: 0.4 }], retention: [100, 80.5] });
    expect(arrays.missingFields).toEqual(['bad', 'huge']);
  });
});
