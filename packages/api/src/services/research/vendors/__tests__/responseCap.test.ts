/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Real TikTok keyword searches are 1.7-2.3 MB of JSON, so the old 2 MiB cap rejected every one of them as unreadable.
// The bodies below have the real shape (a list of videos with the fields the adapter reads) padded with one large
// field per video, like the many unused fields of a real response; no account, title or link is real.
import { describe, expect, it } from 'vitest';
import { MAX_RESPONSE_BYTES } from '../http';
import { callTikhub } from '../tikhub';
import { FIXED_NOW, jsonFetch } from './fetchDoubles';

const deps = (fetchImpl: typeof fetch) => ({ apiKey: 'test-key', fetchImpl, now: FIXED_NOW, timeoutMs: 5000 });
const search = (videos: number, paddingBytes: number) => ({ code: 200, data: { data: Array.from({ length: videos }, (_, i) => ({ aweme_info: {
  aweme_id: `74000000000000000${String(i).padStart(2, '0')}`, desc: `测试视频${i}`, create_time: 1_790_000_000 + i,
  author: { unique_id: `tester${i}`, nickname: `测试账号${i}`, uid: String(i + 1) },
  statistics: { play_count: 1000 + i, digg_count: 50, comment_count: 5, share_count: 2 }, filler: 'x'.repeat(paddingBytes) } })) } });

describe('supplier response size cap', () => {
  it('reads a 2.6 MB keyword search (over the old 2 MiB cap) and keeps the parsed videos', async () => {
    const body = JSON.stringify(search(20, 130_000));
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_RESPONSE_BYTES);
    const result = await callTikhub({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'baby food' }, deps(jsonFetch(200, body)));
    expect(result).toMatchObject({ outcome: 'ok', supplierMayCharge: true, usage: { unit: 'call', units: '1' } });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]!.fields).toMatchObject({ views: 1000, likes: 50 });
  });

  it('still treats a body over the cap as unreadable: unknown result, not resent, never a success', async () => {
    const body = JSON.stringify(search(20, Math.ceil(MAX_RESPONSE_BYTES / 20) + 1000));
    expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_RESPONSE_BYTES);
    const result = await callTikhub({ platform: 'tiktok', kind: 'keyword_posts', keyword: 'baby food' }, deps(jsonFetch(200, body)));
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'RESPONSE_TOO_LARGE', supplierMayCharge: true, items: [] });
  });
});
