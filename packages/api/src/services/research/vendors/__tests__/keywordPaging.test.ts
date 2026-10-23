/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BENCHMARK-COVERAGE PR-1a: keyword search paging. The cursor paths are those of the real TikHub responses recorded on
// 2026-10-23 (all five recorded first or second pages yield a cursor); the bodies here keep only those paths, with
// made-up ids. No test reaches TikHub.
import { describe, expect, it } from 'vitest';
import { keywordCursorParams, keywordNextCursor, validKeywordCursor } from '../keywordPaging';
import { buildTikhubRequest } from '../tikhub';

const DY_SEARCH = '20261023000000ABCDEF0123456789ABCD';
const XHS_SEARCH = '0123456789abcdef';
const XHS_SESSION = '0123456789abcdef0123456789abcdef';
const YT_TOKEN = 'EqkDEhRoYXJkYW5nZXIgZW1icm9pZGVyeRqQA0VnSVFBVWdVZ2dFTGJXTlFObE5wT1dGTGNXdUNBUXQy%3D%3D';
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('keyword search next-page cursors', () => {
  it('reads each platform\'s own cursor only when the supplier says there is more', () => {
    expect(keywordNextCursor({ data: { cursor: 40, has_more: 1 } }, 'tiktok')).toBe('40');
    expect(keywordNextCursor({ data: { cursor: 40, has_more: 0 } }, 'tiktok')).toBeUndefined();
    expect(keywordNextCursor({ data: { business_config: { has_more: 1, next_page: { cursor: 8, search_id: DY_SEARCH } } } }, 'douyin'))
      .toBe(`8:${DY_SEARCH}`);
    expect(keywordNextCursor({ data: { business_config: { has_more: 0, next_page: { cursor: 8, search_id: DY_SEARCH } } } }, 'douyin'))
      .toBeUndefined();
    expect(keywordNextCursor({ data: { next_page: 2, search_id: XHS_SEARCH, search_session_id: XHS_SESSION } }, 'xiaohongshu'))
      .toBe(`2:${XHS_SEARCH}:${XHS_SESSION}`);
    expect(keywordNextCursor({ data: { continuation_token: YT_TOKEN } }, 'youtube')).toBe(YT_TOKEN);
    expect(keywordNextCursor({ data: { cursor: 'abc' } }, 'x')).toBeUndefined();
  });

  it('never passes on a malformed cursor', () => {
    expect(keywordNextCursor({ data: { cursor: -1, has_more: 1 } }, 'tiktok')).toBeUndefined();
    expect(keywordNextCursor({ data: { business_config: { has_more: 1, next_page: { cursor: 8, search_id: 'bad id!' } } } }, 'douyin'))
      .toBeUndefined();
    expect(keywordNextCursor({ data: { continuation_token: 'short' } }, 'youtube')).toBeUndefined();
    for (const [platform, cursor] of [['tiktok', '0'], ['tiktok', '1e3'], ['douyin', '8'], ['xiaohongshu', `1:${XHS_SEARCH}:${XHS_SESSION}`],
      ['youtube', 'has space in it 1234'], ['x', '40']] as const) {
      expect(validKeywordCursor(platform, cursor)).toBe(false);
      expect(keywordCursorParams(platform, cursor)).toEqual({});
    }
  });
});

describe('keyword search next-page requests', () => {
  it('sends the cursor as each platform\'s own parameters', () => {
    const tiktok = buildTikhubRequest({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'hardanger', cursor: '40' });
    expect('request' in tiktok && query(tiktok.request.url)).toMatchObject({ keyword: 'hardanger', offset: '40' });
    const douyin = buildTikhubRequest({ platform: 'douyin', kind: 'keyword_posts', keyword: '苏绣', cursor: `8:${DY_SEARCH}` });
    expect('request' in douyin && douyin.request.body).toMatchObject({ keyword: '苏绣', cursor: 8, search_id: DY_SEARCH });
    const xhs = buildTikhubRequest({ platform: 'xiaohongshu', kind: 'keyword_posts', keyword: '苏绣', cursor: `2:${XHS_SEARCH}:${XHS_SESSION}` });
    expect('request' in xhs && query(xhs.request.url)).toMatchObject({ page: '2', search_id: XHS_SEARCH, search_session_id: XHS_SESSION });
    const youtube = buildTikhubRequest({ platform: 'youtube', kind: 'keyword_posts', keyword: 'hardanger', cursor: YT_TOKEN });
    expect('request' in youtube && query(youtube.request.url).continuation_token).toBe(YT_TOKEN);
  });

  it('keeps the first page unchanged and refuses a bad, foreign or misplaced cursor before any call', () => {
    const first = buildTikhubRequest({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'hardanger' });
    expect('request' in first && query(first.request.url)).toMatchObject({ offset: '0' });
    expect(buildTikhubRequest({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'k', cursor: 'abc' })).toEqual({ reason: 'INVALID_CURSOR' });
    expect(buildTikhubRequest({ platform: 'douyin', kind: 'keyword_posts', keyword: 'k', cursor: '40' })).toEqual({ reason: 'INVALID_CURSOR' });
    expect(buildTikhubRequest({ platform: 'x', kind: 'keyword_posts', keyword: 'k', cursor: '40' })).toEqual({ reason: 'INVALID_CURSOR' });
    expect(buildTikhubRequest({ platform: 'tiktok', kind: 'account_search', keyword: 'k', cursor: '40' })).toEqual({ reason: 'INVALID_CURSOR' });
  });
});
