/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { importManualRows } from './manualImport';

const actor = '00000000-0000-4000-8000-0000000f0001';
const account = '00000000-0000-4000-8000-0000000f0002';
const ok = { data: { connectionId: account, inserted: 1, updated: 0 }, error: null };
const row = (over: Record<string, unknown> = {}) => ({ postKey: 'p1', url: 'https://www.douyin.com/video/1',
  postedAt: '2026-10-01T08:00:00+08:00', titleExcerpt: 'title', metrics: { views: 12000, completion_rate: 45 }, ...over });
const code = (promise: Promise<unknown>) => promise.then(() => 'OK', (error: { code?: string }) => error.code);

describe('publish-monitor manual import', () => {
  it('re-validates confirmed rows and stores them through the manual import function', async () => {
    const rpc = vi.fn().mockResolvedValue(ok);
    await importManualRows({ rpc } as never, actor, { accountProjectId: account, origin: 'table',
      rows: [row({ titleExcerpt: `a\u0000b${'x'.repeat(200)}` })] });
    const args = rpc.mock.calls[0]![1];
    expect(rpc.mock.calls[0]![0]).toBe('publish_monitor_manual_import');
    expect(args.p_rows[0].postedAt).toBe('2026-10-01T00:00:00.000Z');
    expect([...args.p_rows[0].titleExcerpt].length).toBe(120);
    expect(args.p_rows[0].titleExcerpt.startsWith('a b')).toBe(true);
  });

  it('refuses unknown metrics, negative or non-numeric values, rates over 100, unsafe links and empty metrics', async () => {
    const rpc = vi.fn().mockResolvedValue(ok);
    const bad = [{ metrics: { bogus: 1 } }, { metrics: { likes: -1 } }, { metrics: { likes: '3' } },
      { metrics: { completion_rate: 101 } }, { url: 'http://example.com/a' }, { url: 'https://127.0.0.1/a' }, { metrics: {} },
      { postedAt: 'yesterday' }, { postedAt: '2026-02-30T00:00:00Z' }, { postedAt: '2026-10-01' }, { postedAt: '2026-10-01T00:00:00+99:99' }];
    for (const over of bad) {
      expect(await code(importManualRows({ rpc } as never, actor, { accountProjectId: account, origin: 'table',
        rows: [row(over)] } as never))).toBe('PUBLISH_MONITOR_IMPORT_INVALID');
    }
    expect(await code(importManualRows({ rpc } as never, actor, { accountProjectId: account, origin: 'link',
      rows: [row({ url: null })] }))).toBe('PUBLISH_MONITOR_IMPORT_INVALID');
    expect(await code(importManualRows({ rpc } as never, actor, { accountProjectId: account, origin: 'table',
      rows: Array.from({ length: 201 }, () => row()) }))).toBe('PUBLISH_MONITOR_IMPORT_INVALID');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps database refusals to stable codes', async () => {
    const fails = (message: string) => vi.fn().mockResolvedValue({ data: null, error: { message } });
    expect(await code(importManualRows({ rpc: fails('PUBLISH_MONITOR_ACCOUNT_NOT_FOUND') } as never, actor,
      { accountProjectId: account, origin: 'table', rows: [row()] }))).toBe('PUBLISH_MONITOR_ACCOUNT_NOT_FOUND');
    expect(await code(importManualRows({ rpc: fails('boom') } as never, actor,
      { accountProjectId: account, origin: 'table', rows: [row()] }))).toBe('PUBLISH_MONITOR_UNAVAILABLE');
  });
});
