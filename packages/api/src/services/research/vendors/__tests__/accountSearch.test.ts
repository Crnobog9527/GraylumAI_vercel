/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-2: account search routes checked against REAL TikHub responses recorded on 2026-10-23 (TikTok
// fetch_user_search_result, Douyin fetch_user_search, Xiaohongshu search_users). The fixtures keep the real structure
// and follower numbers but replace every name, id and link. No test reaches TikHub.
import { describe, expect, it } from 'vitest';
import { buildTikhubRequest, callTikhub, tikhubRouteId } from '../tikhub';
import { FIXED_NOW, jsonFetch, type RecordedCall } from './fetchDoubles';
import samples from './fixtures/accountSearchSamples.json';

const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 50 });
const search = (platform: 'tiktok' | 'douyin' | 'xiaohongshu', body: unknown, calls: RecordedCall[] = []) =>
  callTikhub({ platform, kind: 'account_search', keyword: 'hardanger embroidery' }, deps(jsonFetch(200, body, calls)));

describe('account search routes', () => {
  it('uses the checked user search endpoints and no follower filter', () => {
    expect(tikhubRouteId('tiktok', 'account_search')).toBe('/tiktok/app/v3/fetch_user_search_result');
    expect(tikhubRouteId('douyin', 'account_search')).toBe('/douyin/search/fetch_user_search');
    expect(tikhubRouteId('xiaohongshu', 'account_search')).toBe('/xiaohongshu/app_v2/search_users');
    expect(tikhubRouteId('youtube', 'account_search')).toBeNull();
    const tiktok = buildTikhubRequest({ platform: 'tiktok', kind: 'account_search', keyword: 'hardanger' });
    expect('request' in tiktok && new URL(tiktok.request.url).searchParams.get('user_search_follower_count')).toBeNull();
    const douyin = buildTikhubRequest({ platform: 'douyin', kind: 'account_search', keyword: '苏绣' });
    expect('request' in douyin && douyin.request).toMatchObject({ method: 'POST',
      body: { keyword: '苏绣', cursor: 0, douyin_user_fans: '', douyin_user_type: '', search_id: '' } });
  });

  it('refuses a bad keyword before any network call', async () => {
    const calls: RecordedCall[] = [];
    const result = await callTikhub({ platform: 'tiktok', kind: 'account_search', keyword: ' ' }, deps(jsonFetch(200, {}, calls)));
    expect(result).toMatchObject({ outcome: 'not_sent', reason: 'INVALID_KEYWORD', supplierMayCharge: false });
    expect(calls).toHaveLength(0);
  });

  it('reads TikTok handles with exact followers and ignores the authors of listed videos', async () => {
    const result = await search('tiktok', samples.tiktok);
    expect(result.outcome).toBe('ok');
    expect(result.items.map(item => [item.fields.id, item.fields.followers])).toEqual([
      ['test.creator0', 49545], ['test.creator1', 227], ['test.creator2', 6229], ['test.creator3', 12883]]);
    expect(result.items[0]!.fields).toMatchObject({ name: 'Test Creator 0', handle: 'test.creator0', postsCount: expect.any(Number) });
  });

  it('reads Douyin sec_user_ids from the wrapped raw data and skips unreadable entries', async () => {
    const result = await search('douyin', samples.douyin);
    expect(result.items.map(item => item.fields.followers)).toEqual([590201, 805868, 109689, 68718]);
    for (const item of result.items) expect(String(item.fields.id)).toMatch(/^MS4wLjABAAAA/);
    expect(result.items[0]!.missing).toContain('handle');
  });

  it('keeps Xiaohongshu abbreviated fan labels missing, never as a count', async () => {
    const result = await search('xiaohongshu', samples.xiaohongshu);
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(String(item.fields.id)).toMatch(/^[0-9a-f]{24}$/);
      expect(item.missing).toContain('followers');
      expect(item.fields).not.toHaveProperty('followers');
    }
  });

  it('keeps a recognized empty user list as a billed no-results answer', async () => {
    const empty = { ...samples.tiktok, data: { ...samples.tiktok.data, user_list: [] } };
    expect(await search('tiktok', empty)).toMatchObject({ outcome: 'ok', reason: 'NO_RESULTS', items: [] });
    const changed = { code: 200, data: { something_else: [] } };
    expect(await search('tiktok', changed)).toMatchObject({ outcome: 'failed', reason: 'EMPTY_OR_UNRECOGNIZED' });
  });
});
